import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { QueryParams } from '@anthropic-ai/claude-agent-sdk';
import { createChangeDetector, type ChangeDetector } from '../../change-detection.js';
import {
  createSessionAttemptCallContext,
  createSessionResumeState,
  isSessionExpiredError,
  runWithResumeFallback,
  sessionResumeMismatchError,
} from '../../session-expiry.js';
import { throwIfAborted } from '../../../utils/abort.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import { createRunnerAttemptCallbackBuffer } from '../../calls/callback-buffer.js';
import { loadSdk } from './availability.js';
import { createSdkCallContext, processStream } from './stream.js';

export interface AgentSdkBackendOpts {
  allowedTools: string[];
  permissionMode: 'acceptEdits' | 'plan';
  role: RunnerCallContext['role'];
  detectChanges?: boolean | undefined;
  apiKey?: string | undefined;
  initialSessionId?: string | null | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export interface AgentSdkInvokeOpts {
  prompt: string;
  projectDir: string;
  model: string;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  onSessionExpired?: ((previousId: string) => void) | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface AgentSdkBackend {
  invoke(opts: AgentSdkInvokeOpts): Promise<RunnerCallResult>;
  detectChanges?: ChangeDetector;
}

function buildPromptWithImages(prompt: string, images: Attachment[] | undefined): string {
  if (!images || images.length === 0) return prompt;
  const refs = images.map((img) => `[image attachment: ${img.path}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

function createForwardedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  cleanup: () => void;
} {
  throwIfAborted(signal);
  const controller = new AbortController();
  if (signal === undefined) return { controller, cleanup: () => {} };
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener('abort', abort),
  };
}

export function createAgentSdkBackend(opts: AgentSdkBackendOpts): AgentSdkBackend {
  const { permissionMode, role } = opts;
  const session = createSessionResumeState();
  session.capture(opts.initialSessionId ?? null);

  const backend: AgentSdkBackend = {
    async invoke({
      prompt,
      projectDir,
      model,
      onOutput,
      onSessionId,
      onCallEvent,
      onSessionExpired,
      effort,
      images,
      signal,
      callContext,
      env,
    }) {
      throwIfAborted(signal);
      const { query } = await loadSdk();

      const apiKey = opts.apiKey;
      const finalPrompt = buildPromptWithImages(prompt, images);
      const baseCallContext = callContext ?? createSdkCallContext({ role, model });

      const runQuery = async (resumeId: string | undefined, attempt: number) => {
        throwIfAborted(signal);
        const forwardedAbort = createForwardedAbortController(signal);
        const callbackBuffer =
          resumeId === undefined
            ? null
            : createRunnerAttemptCallbackBuffer({ onOutput, onSessionId, onCallEvent });
        const attemptCallbacks = callbackBuffer?.callbacks ?? {
          onOutput,
          onSessionId,
          onCallEvent,
        };
        let unexpectedResumeSessionId: string | null = null;
        const captureSession = (id: string) => {
          if (resumeId !== undefined && id !== resumeId) {
            unexpectedResumeSessionId = id;
            return;
          }
          session.capture(id);
          attemptCallbacks.onSessionId?.(id);
        };
        const options: QueryParams['options'] = {
          allowedTools: opts.allowedTools,
          permissionMode,
          model,
          cwd: projectDir,
          includePartialMessages: true,
          abortController: forwardedAbort.controller,
        };
        if (resumeId) options.resume = resumeId;
        if (effort) options.effort = effort;
        if (env || apiKey) {
          options.env = {
            ...(env ?? process.env),
            ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
          };
        }
        try {
          const result = await processStream({
            stream: query({ prompt: finalPrompt, options }),
            onOutput: attemptCallbacks.onOutput,
            onSessionId: captureSession,
            onCallEvent: attemptCallbacks.onCallEvent,
            callContext: createSessionAttemptCallContext(baseCallContext, attempt),
            signal,
            forwardedAbortController: forwardedAbort.controller,
            idle: { warnMs: opts.idleWarnMs, killMs: opts.idleKillMs },
          });
          const returnedSessionId = result.sessionId ?? unexpectedResumeSessionId;
          if (
            resumeId !== undefined &&
            returnedSessionId !== null &&
            returnedSessionId !== resumeId
          ) {
            throw sessionResumeMismatchError(resumeId, returnedSessionId);
          }
          callbackBuffer?.flush();
          return result;
        } catch (err) {
          if (resumeId === undefined || !isSessionExpiredError(err)) callbackBuffer?.flush();
          throw err;
        } finally {
          forwardedAbort.cleanup();
        }
      };

      const priorId = session.getResumeId();
      const result = await runWithResumeFallback(
        session,
        (resumeId, attempt) => runQuery(resumeId, attempt),
        () => {
          if (priorId) onSessionExpired?.(priorId);
        },
      );
      return result;
    },
  };

  if (opts.detectChanges) {
    backend.detectChanges = createChangeDetector('Agent SDK');
  }

  return backend;
}
