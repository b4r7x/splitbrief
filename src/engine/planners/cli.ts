import { matches } from '../../utils/error.js';

import type { Config } from '../../core/schemas/config.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { Planner, PlannerCallbacks, PlannerFactoryOptions } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import {
  CLI_NO_DEADLINE_MS,
  invokeCliAdapter,
  toCliEnvironment,
} from '../runners/invoke-cli-adapter.js';
import { CLI_PROMPT_SENTINEL } from '../runners/cli-tools/candidate-contract.js';
import { lookupCliPlannerAdapter } from '../runners/cli-tools/registry.js';
import type { CliPlannerAdapter } from '../runners/cli-tools/contract.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { assertPlannerKind } from '../config-assertions.js';
import {
  isSessionExpiredError,
  sessionResumeExpiredError,
  sessionResumeMismatchError,
} from '../session-expiry.js';
import {
  capturePlanningMutationBaseline,
  findUnexpectedPlanningMutations,
  planningMutationError,
} from '../orchestrator/planning/mutation-guard.js';
import { composeAbortSignal } from '../../utils/abort.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { resolveCliExecutableAliases } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate } from '../runners/start-gate.js';
import { processError } from '../../lib/process/errors.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { createQuestionAccumulator } from '../parsers/question.js';
const isCliExecutableUnavailable = matches('cli-executable-unavailable');

function cliNotFoundMessage(descriptor: CliPlannerAdapter['descriptor']): string {
  return `${descriptor.displayName} not found. See ${descriptor.compatibility.installUrl}`;
}

function isRecoverableResumeNoise(event: RunnerCallEvent, resumeId: string): boolean {
  switch (event.type) {
    case 'call_stderr_delta':
      return isSessionExpiredError(event.text);
    case 'call_session_id':
      return event.nativeSessionId !== resumeId;
    default:
      return false;
  }
}

export function createCliPlanner(
  opts: PlannerFactoryOptions & { config: Config; initialSessionId?: string | null | undefined },
): Planner {
  const { config, initialSessionId, trustedCli } = opts;
  const plannerCfg = assertPlannerKind(config, 'cli');
  resolveCliRunnerAuth(plannerCfg);
  const resolvedModel = resolveCliModel(plannerCfg.model, plannerCfg.tool);
  const adapter = lookupCliPlannerAdapter(plannerCfg.tool);
  const command = adapter.descriptor.command;
  const notFoundMessage = cliNotFoundMessage(adapter.descriptor);
  const { supportsSessionResume, supportsEffort } = adapter;

  const effort = plannerCfg.effort;
  const timeout = plannerCfg.timeout;
  const extraArgs = plannerCfg.args ?? [];

  async function resolveExecutable(projectDir: string): Promise<CliExecutableIdentity> {
    try {
      return (
        await resolveCliExecutableAliases({
          commands: adapter.descriptor.executableAliases,
          projectDir,
          trust: assertCliStartGate(plannerCfg.tool, trustedCli),
        })
      ).executable;
    } catch (err) {
      if (isCliExecutableUnavailable(err)) {
        throw processError.notFound(command, notFoundMessage);
      }
      throw err;
    }
  }

  async function runOnce(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onSessionId' | 'onCallEvent'>;
    callContext: RunnerCallContext;
    mode: 'plan' | 'escalate';
    resumeId: string | null;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> {
    const { prompt, projectDir, callbacks, callContext, mode, resumeId, signal, sandboxEnv } = opts;
    let unexpectedResumeSessionId: string | null = null;
    let stderrOutput = '';
    const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;
    const onOutput = (text: string): void => {
      callbacks.onOutput(text);
      if (questionAccumulator === null) return;
      const newQuestions = questionAccumulator.addChunk(text);
      if (newQuestions.length > 0) callbacks.onQuestion?.(newQuestions);
    };

    const effectiveSignal = composeAbortSignal(signal, timeout);
    const onCallEvent = (event: RunnerCallEvent): void => {
      if (event.type === 'call_stderr_delta') {
        stderrOutput = `${stderrOutput}${event.text}`.slice(-8_192);
      }
      if (resumeId && isRecoverableResumeNoise(event, resumeId)) return;
      callbacks.onCallEvent?.(event);
    };

    const executable = await resolveExecutable(projectDir);
    const baseArgs = adapter.baseArgs({
      prompt: CLI_PROMPT_SENTINEL,
      model: resolvedModel,
      projectDir,
      configuredArgs: extraArgs,
      mode,
      sessionId: supportsSessionResume ? resumeId : null,
      effort: supportsEffort ? effort : undefined,
    });
    const result = await invokeCliAdapter({
      adapter,
      invocation: {
        executable,
        args: [...baseArgs, ...extraArgs],
        baseArgs,
        promptTransport: adapter.promptTransport,
        environment: toCliEnvironment(
          sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, plannerCfg, 'planner')),
        ),
        cwd: projectDir,
        timeoutMs: timeout ?? CLI_NO_DEADLINE_MS,
        signal: effectiveSignal,
      },
      prompt,
      callContext,
      onOutput,
      onCallEvent,
      onSessionId:
        supportsSessionResume && mode === 'plan'
          ? (id: string) => {
              if (resumeId && id !== resumeId) {
                unexpectedResumeSessionId = id;
                return;
              }
              callbacks.onSessionId?.(id);
            }
          : undefined,
      idle: {
        warnMs: plannerCfg.idleWarnMs,
        killMs: plannerCfg.idleKillMs,
      },
    });

    const returnedSessionId = result.nativeSessionId ?? unexpectedResumeSessionId;
    if (resumeId && returnedSessionId !== null && returnedSessionId !== resumeId) {
      throw sessionResumeMismatchError(resumeId, returnedSessionId);
    }

    if (result.status !== 'completed' && resumeId) {
      const failureText = `${result.error?.message ?? result.text}\n${stderrOutput}`;
      if (isSessionExpiredError(failureText)) {
        throw sessionResumeExpiredError(resumeId, failureText);
      }
    }
    return result;
  }

  async function invoke(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'sessionId' | 'onCallEvent'
    >;
    callContext: RunnerCallContext;
    accessMode: 'planning' | 'read-only' | 'write-files';
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> {
    const { prompt, projectDir, callbacks, callContext, accessMode, signal, sandboxEnv } = opts;
    const shouldGuardMutations =
      accessMode === 'read-only' ||
      (accessMode === 'planning' && callbacks.sessionId !== undefined);
    if (shouldGuardMutations) await resolveExecutable(projectDir);
    const environment =
      sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, plannerCfg, 'planner'));
    const mutationBaseline = shouldGuardMutations
      ? await capturePlanningMutationBaseline(projectDir)
      : null;
    const adapterMode = accessMode === 'write-files' ? 'escalate' : 'plan';

    const finish = async (result: RunnerCallResult): Promise<RunnerCallResult> => {
      if (mutationBaseline !== null) {
        const unexpected = await findUnexpectedPlanningMutations({
          projectDir,
          baseline: mutationBaseline,
          internalStatePaths: adapter.descriptor.internalStatePaths,
        });
        if (unexpected.length > 0) {
          throw planningMutationError.unexpectedMutations(unexpected);
        }
      }
      return result;
    };

    const detached = callContext.sessionScope?.kind === 'detached-fresh';
    const resumeId =
      supportsSessionResume && accessMode !== 'write-files' && !detached
        ? (callbacks.sessionId ?? initialSessionId ?? null)
        : null;
    try {
      return await finish(
        await runOnce({
          prompt,
          projectDir,
          callbacks,
          callContext,
          mode: adapterMode,
          resumeId,
          signal,
          sandboxEnv: environment,
        }),
      );
    } catch (err) {
      if (resumeId !== null && isSessionExpiredError(err)) {
        callbacks.onSessionExpired?.(resumeId);
      }
      throw err;
    }
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks, callContext, signal }) =>
      invoke({
        prompt,
        projectDir,
        callbacks,
        callContext,
        accessMode: 'planning',
        signal,
      }),
    invokeEscalate: ({
      prompt,
      projectDir,
      callbacks,
      callContext,
      accessMode,
      signal,
      sandboxEnv,
    }) => invoke({ prompt, projectDir, callbacks, callContext, accessMode, signal, sandboxEnv }),
    runnerName: plannerCfg.tool,
    ...(resolvedModel !== undefined && { model: resolvedModel }),
    hintSuccessMode: 'text',
    escalateFullMode: 'files',

    ...createCommandAvailability(adapter.descriptor.executableAliases, {
      timeout: adapter.probe.version.timeoutMs,
    }),

    capabilities: { ...ONE_SHOT_API_CAPS, supportsSessionResume, supportsEffort },
  });
}
