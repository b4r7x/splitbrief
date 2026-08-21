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
import { createRunnerCallRecorder } from '../../calls/recorder.js';
import type { TaskDispatchLedger } from '../../calls/dispatch-ledger.js';
import {
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationFailureCode,
} from '../../../core/schemas/task-compilation.js';
import { loadSdk } from './availability.js';
import { createSdkCallContext, processStream } from './stream.js';

const PLANNER_READ_ONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

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
  ledger?: TaskDispatchLedger | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
  attemptId?: TaskCompilationAttemptId | undefined;
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

function plannerCapabilityViolation(
  allowedTools: readonly string[],
  permissionMode: string,
): string | null {
  if (permissionMode !== 'plan') {
    return `Agent SDK planner role requires permissionMode 'plan', got '${permissionMode}'`;
  }
  const foreignTools = allowedTools.filter((tool) => !PLANNER_READ_ONLY_TOOLS.includes(tool));
  if (foreignTools.length > 0) {
    return `Agent SDK planner role allows only Read/Glob/Grep tools, got ${foreignTools.join(', ')}`;
  }
  return null;
}

function refusedAgentSdkResult(
  callContext: RunnerCallContext,
  code: TaskCompilationFailureCode,
  message: string,
): RunnerCallResult {
  return createRunnerCallRecorder({ context: callContext }).finishFailed({
    status: 'refused',
    error: { code, message },
  });
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
      ledger,
      envelope,
      attemptId,
    }) {
      throwIfAborted(signal);
      const baseCallContext = {
        ...(callContext ?? createSdkCallContext({ role, model })),
        ...(envelope !== undefined && { envelope }),
      };
      if (role === 'planner') {
        const violation = plannerCapabilityViolation(opts.allowedTools, permissionMode);
        if (violation !== null) {
          return refusedAgentSdkResult(
            baseCallContext,
            'task_compiler_capability_unsupported',
            violation,
          );
        }
      }

      const { query } = await loadSdk();

      const apiKey = opts.apiKey;
      const finalPrompt = buildPromptWithImages(prompt, images);
      const detached = baseCallContext.sessionScope?.kind === 'detached-fresh';

      const runQuery = async (resumeId: string | undefined, attempt: number) => {
        throwIfAborted(signal);
        const claimAttemptId =
          attempt === 1
            ? (attemptId ?? baseCallContext.attemptId ?? createTaskCompilationAttemptId())
            : createTaskCompilationAttemptId();
        const attemptCallContext = {
          ...createSessionAttemptCallContext(baseCallContext, attempt),
          attemptId: claimAttemptId,
        };
        if (ledger !== undefined) {
          const claim = ledger.claimDispatch(claimAttemptId);
          if (claim.kind === 'refused') {
            return refusedAgentSdkResult(
              attemptCallContext,
              'task_compiler_dispatch_limit',
              `operation dispatch limit reached (${claim.dispatchCount}/${claim.dispatchLimit})`,
            );
          }
        }
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
          if (!detached) {
            session.capture(id);
            attemptCallbacks.onSessionId?.(id);
          }
        };
        const options: QueryParams['options'] = {
          allowedTools: opts.allowedTools,
          permissionMode,
          model,
          cwd: projectDir,
          includePartialMessages: true,
          abortController: forwardedAbort.controller,
        };
        if (resumeId && !detached) options.resume = resumeId;
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
            callContext: attemptCallContext,
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
      const result = detached
        ? await runQuery(undefined, 1)
        : await runWithResumeFallback(
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
