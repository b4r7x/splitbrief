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
import { resolveCliModel } from '../../core/providers/automatic-model.js';
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
import type { CliAuthChannelId } from '../../core/runners/cli-tool-catalog.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';

type ClaudeStartGate = Readonly<{ executable: CliExecutableIdentity }>;

const CLAUDE_TOOL = 'claude-code' as const;

export function createClaudeCodePlanner(opts: {
  authChannel: CliAuthChannelId | undefined;
  trustedCli?: ClaudeStartGate | undefined;
  model?: string | undefined;
  initialSessionId?: string | null | undefined;
  effort?: EffortLevel | undefined;
  args?: readonly string[] | undefined;
  timeout?: number | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}): Planner {
  const { trustedCli, model, initialSessionId, effort, args, timeout, idleWarnMs, idleKillMs } =
    opts;
  // The resolved channel — not the configured one — decides which credential the
  // child receives, so the stream invocations must see the same identity the
  // sandbox environment was built from.
  const authChannel = resolveCliRunnerAuth({
    kind: 'cli',
    tool: CLAUDE_TOOL,
    authChannel: opts.authChannel,
  }).id;
  const runnerConfig = { kind: 'cli' as const, tool: CLAUDE_TOOL, authChannel };
  const resolvedModel = resolveCliModel(model, CLAUDE_TOOL);
  const session = createSessionResumeState();
  session.capture(initialSessionId ?? null);

  /**
   * One prep for every specialized path (plan stream, one-shot escalate, user
   * injection): the admitted vector is model + auth channel + trusted
   * executable + effort + configured tail + idle bounds, assembled exactly
   * once so no path can diverge on what reaches the child. The prompt itself
   * is the only instruction channel — everything else stays the adapter's
   * admitted argv.
   */
  function claudeRunnerPrep(input: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
  }): Readonly<{
    model: string | undefined;
    authChannel: CliAuthChannelId;
    env: NodeJS.ProcessEnv;
    executable?: CliExecutableIdentity | undefined;
    effort?: EffortLevel | undefined;
    configuredArgs: readonly string[] | undefined;
    signal?: AbortSignal | undefined;
    idleWarnMs?: number | undefined;
    idleKillMs?: number | undefined;
  }> {
    return {
      model: resolvedModel,
      authChannel,
      env: input.env,
      ...(trustedCli !== undefined && { executable: trustedCli.executable }),
      ...(effort !== undefined && { effort }),
      configuredArgs: args,
      ...(input.signal !== undefined && { signal: input.signal }),
      ...(idleWarnMs !== undefined && { idleWarnMs }),
      ...(idleKillMs !== undefined && { idleKillMs }),
    };
  }

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
          const env = await createRunnerSandboxEnv(projectDir, runnerConfig, 'planner');
          const result = await runClaudePlannerStream({
            prompt,
            projectDir,
            sessionId: resumeId ?? null,
            onOutput: attemptCallbacks.onOutput,
            onSessionId: attemptCallbacks.onSessionId,
            onQuestion: attemptCallbacks.onQuestion,
            onCallEvent: attemptCallbacks.onCallEvent,
            callContext: createSessionAttemptCallContext(callContext, attempt),
            ...claudeRunnerPrep({ env, signal: effectiveSignal }),
            ...(images && images.length > 0 ? { images } : {}),
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
      const env = sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, runnerConfig, 'planner'));
      return runClaudeOneShot({
        prompt,
        projectDir,
        onOutput: callbacks.onOutput,
        onCallEvent: callbacks.onCallEvent,
        callContext,
        ...claudeRunnerPrep({ env, signal: effectiveSignal }),
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
        const env = await createRunnerSandboxEnv(injection.projectDir, runnerConfig, 'planner');
        const result = await runClaudePlannerStream({
          prompt: injection.text,
          projectDir: injection.projectDir,
          sessionId,
          onOutput: callbackBuffer.callbacks.onOutput,
          onCallEvent: callbackBuffer.callbacks.onCallEvent,
          ...(injection.callContext !== undefined && { callContext: injection.callContext }),
          ...claudeRunnerPrep({ env, signal: effectiveSignal }),
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
