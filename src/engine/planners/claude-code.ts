import { error } from '../../utils/error.js';
import type {
  Planner,
  PlannerCallbacks,
  EscalationResult,
  PlannerUserTurnResult,
} from './types.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { CONVERSATIONAL_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createPlannerCallContext } from './call-context.js';
import { seatAxisWords } from '../../core/runners/effort-channel.js';
import { createCommandAvailability } from '../availability.js';
import { writeProjectFile } from '../../core/paths-io.js';
import { invokeClaudePlanner } from './claude-invoke.js';
import { toTokenDelta } from '../calls/projection.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import {
  createSessionResumeState,
  isSessionExpiredError,
  sessionResumeMismatchError,
} from '../session-expiry.js';
import { composeAbortSignal } from '../../utils/abort.js';
import type { RunnerCallContext } from '../calls/types.js';
import { createRunnerAttemptCallbackBuffer } from '../calls/callback-buffer.js';
import type { TypedSchemaInput } from '../runners/typed-output.js';
import {
  type CliAuthChannelId,
  typedOutputCapability,
} from '../../core/runners/cli-tool-catalog.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';

type ClaudeStartGate = Readonly<{
  executable: CliExecutableIdentity;
  installedVersion?: string | undefined;
}>;

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
  /** The run's global skills, which every call of this seat may read and never write. */
  skillRoots?: readonly string[] | undefined;
}): Planner {
  const {
    trustedCli,
    model,
    initialSessionId,
    effort,
    args,
    timeout,
    idleWarnMs,
    idleKillMs,
    skillRoots,
  } = opts;
  // The resolved channel — not the configured one — decides which credential the
  // child receives, so the stream invocations must see the same identity the
  // sandbox environment was built from. Only the configured one is admitted at
  // dispatch, so a resolved default never poses as an explicit choice.
  const authChannel = resolveCliRunnerAuth({
    kind: 'cli',
    tool: CLAUDE_TOOL,
    authChannel: opts.authChannel,
  }).id;
  const runnerConfig = { kind: 'cli' as const, tool: CLAUDE_TOOL, authChannel, model, effort };
  const resolvedModel = resolveCliModel(model, CLAUDE_TOOL);
  const identityConfig = {
    backendKind: 'cli' as const,
    runnerName: 'claude',
    model: resolvedModel,
    axes: seatAxisWords(runnerConfig),
  };
  const session = createSessionResumeState();
  session.capture(initialSessionId ?? null);

  function claudeRunnerPrep(input: { env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined }) {
    return {
      model: resolvedModel,
      authChannel,
      configuredAuthChannel: opts.authChannel,
      env: input.env,
      trustedCli,
      ...(effort !== undefined && { effort }),
      configuredArgs: args,
      ...(skillRoots !== undefined && { skillRoots }),
      ...(input.signal !== undefined && { signal: input.signal }),
      ...(idleWarnMs !== undefined && { idleWarnMs }),
      ...(idleKillMs !== undefined && { idleKillMs }),
    };
  }

  async function invokeOnSession(
    prompt: string,
    projectDir: string,
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onSessionId' | 'onSessionExpired' | 'onCallEvent' | 'steering'
    >,
    callContext: RunnerCallContext,
    images?: Attachment[] | undefined,
    signal?: AbortSignal | undefined,
    schema?: TypedSchemaInput | undefined,
  ) {
    const resumeId = session.getResumeId() ?? undefined;
    const effectiveSignal = composeAbortSignal(signal, timeout);
    let resumeConfirmed = false;
    let mismatchedId: string | undefined;
    const callbackBuffer =
      resumeId === undefined ? null : createRunnerAttemptCallbackBuffer(callbacks);
    const attemptCallbacks = callbackBuffer?.callbacks ?? callbacks;
    try {
      const env = await createRunnerSandboxEnv(projectDir, runnerConfig, 'planner');
      const result = await invokeClaudePlanner({
        prompt,
        projectDir,
        mode: 'plan',
        sessionId: resumeId ?? null,
        callbacks: {
          ...attemptCallbacks,
          steering: callbacks.steering,
          onSessionInit: (id) => {
            if (resumeId !== undefined && id !== resumeId) {
              mismatchedId = id;
              return;
            }
            if (id === resumeId && mismatchedId === undefined) {
              resumeConfirmed = true;
              callbackBuffer?.flush();
            }
          },
          // The native id is captured as it streams, not after the call returns:
          // the next phase resumes the same conversation even when this one is
          // interrupted, and a run cut mid-call still has a thread to pick up.
          onSessionId: (id: string) => {
            if (resumeId !== undefined && id !== resumeId) {
              mismatchedId = id;
              return;
            }
            session.capture(id);
            attemptCallbacks.onSessionId?.(id);
          },
        },
        callContext,
        ...claudeRunnerPrep({ env, signal: effectiveSignal }),
        ...(images && images.length > 0 ? { images } : {}),
        ...(schema !== undefined && { schema: { json: schema.json } }),
      });
      const returnedSessionId = mismatchedId ?? result.nativeSessionId;
      if (resumeId !== undefined && returnedSessionId !== null && returnedSessionId !== resumeId) {
        throw sessionResumeMismatchError(resumeId, returnedSessionId);
      }
      callbackBuffer?.flush();
      return result;
    } catch (caught) {
      const err =
        mismatchedId !== undefined && resumeId !== undefined
          ? sessionResumeMismatchError(resumeId, mismatchedId)
          : caught;
      if (resumeConfirmed && isSessionExpiredError(err)) {
        throw error(
          'session-resume-failed',
          'The confirmed Claude session failed; continue this step to retry.',
          { cause: err },
        );
      }
      // A session Claude no longer holds fails the call, as a codex thread does: the run drops
      // the saved id, and the next call starts a fresh session on the rebuilt transcript.
      if (resumeId !== undefined && isSessionExpiredError(err)) {
        session.capture(null);
        callbacks.onSessionExpired?.(resumeId);
        throw err;
      }
      callbackBuffer?.flush();
      throw err;
    }
  }

  return createPlannerBase({
    async invokePlan({ prompt, projectDir, callbacks, callContext, images, signal, schema }) {
      return invokeOnSession(prompt, projectDir, callbacks, callContext, images, signal, schema);
    },

    async invokeEscalate({
      prompt,
      projectDir,
      callbacks,
      callContext,
      accessMode,
      signal,
      sandboxEnv,
      images,
      schema,
    }) {
      const effectiveSignal = composeAbortSignal(signal, timeout);
      const env = sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, runnerConfig, 'planner'));
      return invokeClaudePlanner({
        prompt,
        projectDir,
        mode: accessMode === 'write-files' ? 'escalate' : 'plan',
        sessionId: null,
        callbacks,
        callContext,
        ...claudeRunnerPrep({ env, signal: effectiveSignal }),
        ...(images !== undefined && images.length > 0 ? { images } : {}),
        ...(schema !== undefined && { schema: { json: schema.json } }),
      });
    },

    ...createCommandAvailability('claude'),
    ...identityConfig,
    typedOutput: typedOutputCapability(CLAUDE_TOOL, trustedCli?.installedVersion),

    async injectUserTurn(injection): Promise<PlannerUserTurnResult> {
      const sessionId = session.getResumeId();
      if (!sessionId) return { status: 'not-delivered', reason: 'not-ready' };
      const effectiveSignal = composeAbortSignal(injection.signal, timeout);
      const callbackBuffer = createRunnerAttemptCallbackBuffer({
        onOutput: () => {},
        onCallEvent: injection.callbacks?.onCallEvent,
      });
      let flushCallbacks = true;
      let resumeConfirmed = false;
      let mismatchedId: string | undefined;
      try {
        const env = await createRunnerSandboxEnv(injection.projectDir, runnerConfig, 'planner');
        const result = await invokeClaudePlanner({
          prompt: injection.text,
          projectDir: injection.projectDir,
          mode: 'plan',
          sessionId,
          callbacks: {
            ...callbackBuffer.callbacks,
            onSessionId: (id) => {
              if (id !== sessionId) mismatchedId = id;
            },
            onSessionInit: (id) => {
              if (id !== sessionId) mismatchedId = id;
              if (id === sessionId && mismatchedId === undefined) {
                resumeConfirmed = true;
                callbackBuffer.flush();
              }
            },
          },
          callContext: injection.callContext ?? createPlannerCallContext(identityConfig, 'planner'),
          ...claudeRunnerPrep({ env, signal: effectiveSignal }),
        });
        const returnedSessionId = mismatchedId ?? result.nativeSessionId ?? sessionId;
        if (returnedSessionId !== null && returnedSessionId !== sessionId) {
          flushCallbacks = false;
          throw sessionResumeMismatchError(sessionId, returnedSessionId);
        }
        session.capture(returnedSessionId);
        callbackBuffer.flush();
        return { status: 'delivered', usage: toTokenDelta(result.usage) };
      } catch (caught) {
        const err =
          mismatchedId !== undefined ? sessionResumeMismatchError(sessionId, mismatchedId) : caught;
        if (resumeConfirmed && isSessionExpiredError(err)) {
          throw error(
            'session-resume-failed',
            'The confirmed Claude session failed; continue this step to retry.',
            { cause: err },
          );
        }
        if (flushCallbacks && !isSessionExpiredError(err)) callbackBuffer.flush();
        throw err;
      }
    },

    capabilities: CONVERSATIONAL_CAPS,

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      writeProjectFile(projectDir, task.suggestedFiles[0], extracted.code);
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
