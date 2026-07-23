import type { Planner, EscalationResult } from './types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { CONVERSATIONAL_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import { writeProjectFile } from '../../core/paths-io.js';
import { runClaudePlannerStream, runClaudeOneShot } from '../runners/claude/invoke.js';
import { toTokenDelta } from '../calls/projection.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import {
  createSessionAttemptCallContext,
  createSessionResumeState,
  isSessionExpiredError,
  runWithResumeFallback,
  sessionResumeMismatchError,
} from '../session-expiry.js';
import { composeAbortSignal } from '../../utils/abort.js';
import type { RunnerCallContext } from '../calls/types.js';
import { createRunnerAttemptCallbackBuffer } from '../calls/callback-buffer.js';

export function createClaudeCodePlanner(opts: {
  model?: string | undefined;
  initialSessionId?: string | null | undefined;
  effort?: EffortLevel | undefined;
  timeout?: number | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}): Planner {
  const { model, initialSessionId, effort, timeout, idleWarnMs, idleKillMs } = opts;
  const resolvedModel = resolveAutoModel(model, 'claude-code');
  const session = createSessionResumeState();
  session.capture(initialSessionId ?? null);

  async function invokeWithSessionFallback(
    prompt: string,
    projectDir: string,
    callbacks: {
      onOutput: (text: string) => void;
      onSessionId?: ((id: string) => void) | undefined;
      onSessionExpired?: ((id: string) => void) | undefined;
      onQuestion?: ((q: ClarificationQuestion[]) => void) | undefined;
      onCallEvent?: Parameters<typeof runClaudePlannerStream>[0]['onCallEvent'];
    },
    callContext: RunnerCallContext,
    images?: Attachment[] | undefined,
    signal?: AbortSignal | undefined,
  ) {
    const priorId = session.getResumeId();
    const effectiveSignal = composeAbortSignal(signal, timeout);
    return runWithResumeFallback(
      session,
      async (resumeId, attempt) => {
        const callbackBuffer =
          resumeId === undefined ? null : createRunnerAttemptCallbackBuffer(callbacks);
        const attemptCallbacks = callbackBuffer?.callbacks ?? callbacks;
        try {
          const result = await runClaudePlannerStream({
            prompt,
            projectDir,
            sessionId: resumeId ?? null,
            onOutput: attemptCallbacks.onOutput,
            onSessionId: attemptCallbacks.onSessionId,
            onQuestion: attemptCallbacks.onQuestion,
            onCallEvent: attemptCallbacks.onCallEvent,
            callContext: createSessionAttemptCallContext(callContext, attempt),
            model: resolvedModel,
            ...(effort !== undefined && { effort }),
            ...(images && images.length > 0 ? { images } : {}),
            ...(effectiveSignal !== undefined && { signal: effectiveSignal }),
            ...(idleWarnMs !== undefined && { idleWarnMs }),
            ...(idleKillMs !== undefined && { idleKillMs }),
          });
          const returnedSessionId = result.sessionId ?? result.nativeSessionId;
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
        }
      },
      () => {
        if (priorId) callbacks.onSessionExpired?.(priorId);
      },
    );
  }

  return createPlannerBase({
    backendKind: 'cli',

    async invokePlan({ prompt, projectDir, callbacks, callContext, images, signal }) {
      const result = await invokeWithSessionFallback(
        prompt,
        projectDir,
        callbacks,
        callContext,
        images,
        signal,
      );
      const nextSessionId = result.sessionId ?? result.nativeSessionId;
      session.capture(nextSessionId);
      return result;
    },

    async invokeEscalate({ prompt, projectDir, callbacks, callContext, signal, sandboxEnv }) {
      const effectiveSignal = composeAbortSignal(signal, timeout);
      return runClaudeOneShot({
        prompt,
        projectDir,
        onOutput: callbacks.onOutput,
        onCallEvent: callbacks.onCallEvent,
        callContext,
        model: resolvedModel,
        ...(effort !== undefined && { effort }),
        ...(effectiveSignal !== undefined && { signal: effectiveSignal }),
        ...(sandboxEnv !== undefined && { env: sandboxEnv }),
        ...(idleWarnMs !== undefined && { idleWarnMs }),
        ...(idleKillMs !== undefined && { idleKillMs }),
      });
    },

    ...createCommandAvailability('claude'),
    runnerName: 'claude',
    ...(resolvedModel !== undefined && { model: resolvedModel }),

    async injectUserTurn(injection): Promise<TokenDelta | null> {
      const sessionId = session.getResumeId();
      if (!sessionId) return null;
      const effectiveSignal = composeAbortSignal(injection.signal, timeout);
      const callbackBuffer = createRunnerAttemptCallbackBuffer({
        onOutput: () => {},
        onCallEvent: injection.callbacks?.onCallEvent,
      });
      let flushCallbacks = true;
      try {
        const result = await runClaudePlannerStream({
          prompt: injection.text,
          projectDir: injection.projectDir,
          sessionId,
          onOutput: callbackBuffer.callbacks.onOutput,
          onCallEvent: callbackBuffer.callbacks.onCallEvent,
          ...(injection.callContext !== undefined && { callContext: injection.callContext }),
          model: resolvedModel,
          ...(effort !== undefined && { effort }),
          ...(effectiveSignal !== undefined && { signal: effectiveSignal }),
          ...(idleWarnMs !== undefined && { idleWarnMs }),
          ...(idleKillMs !== undefined && { idleKillMs }),
        });
        const returnedSessionId = result.sessionId ?? result.nativeSessionId;
        if (returnedSessionId !== null && returnedSessionId !== sessionId) {
          flushCallbacks = false;
          throw sessionResumeMismatchError(sessionId, returnedSessionId);
        }
        session.capture(returnedSessionId);
        callbackBuffer.flush();
        return toTokenDelta(result.usage);
      } catch (err) {
        if (flushCallbacks && !isSessionExpiredError(err)) callbackBuffer.flush();
        throw err;
      }
    },

    capabilities: CONVERSATIONAL_CAPS,

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      writeProjectFile(projectDir, task.file, extracted.code);
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
