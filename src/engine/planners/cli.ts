import { matches } from '../../utils/error.js';

import type { Config } from '../../core/schemas/config.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { Planner, PlannerCallbacks, PlannerFactoryOptions } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import { invokeCliAdapter, toCliEnvironment } from '../runners/invoke-cli-adapter.js';
import { CLI_PROMPT_SENTINEL } from '../runners/cli-tools/candidate-contract.js';
import { lookupCliPlannerAdapter } from '../runners/cli-tools/registry.js';
import { typedOutputCapability } from '../../core/runners/cli-tool-catalog.js';
import { seatSupportsImages } from '../../core/runners/capabilities.js';
import type { CliPlannerAdapter, CliSchemaInput } from '../runners/cli-tools/contract.js';
import type { TypedSchemaInput } from '../runners/typed-output.js';
import { withSchemaFile } from '../runners/schema-file.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { assertPlannerKind } from '../config-assertions.js';
import {
  createSessionResumeState,
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
import { seatAxisWords } from '../../core/runners/effort-channel.js';
import { resolveCliExecutableAliases } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate } from '../runners/start-gate.js';
import { processError } from '../../lib/process/errors.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { withCliInvocationIdentity } from '../runners/invocation-identity.js';
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

  // The only thread a CLI resumes is one it reported itself. The SPLITBRIEF session
  // id is not a tool thread id, so it never reaches --resume.
  const nativeSession = createSessionResumeState();
  nativeSession.capture(initialSessionId ?? null);

  const effort = plannerCfg.effort;
  const variant = plannerCfg.variant;
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
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId' | 'onCallEvent' | 'steering'>;
    callContext: RunnerCallContext;
    mode: 'plan' | 'escalate';
    threaded: boolean;
    resumeId: string | null;
    images?: readonly Attachment[] | undefined;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
    schema?: CliSchemaInput | undefined;
  }): Promise<RunnerCallResult> {
    const {
      prompt,
      projectDir,
      callbacks,
      callContext,
      mode,
      threaded,
      resumeId,
      images,
      signal,
      sandboxEnv,
    } = opts;
    let unexpectedResumeSessionId: string | null = null;
    let stderrOutput = '';

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
      oneShot: !threaded,
      effort: supportsEffort ? effort : undefined,
      variant,
      installedVersion: trustedCli?.installedVersion,
      schema: opts.schema,
      ...(images !== undefined && images.length > 0
        ? { imagePaths: images.map((image) => image.path) }
        : {}),
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
        images,
        timeoutMs: timeout,
        signal: effectiveSignal,
      },
      prompt,
      steering: callbacks.steering,
      installedVersion: trustedCli?.installedVersion,
      callContext: withCliInvocationIdentity({ runner: plannerCfg, callContext, executable }),
      onOutput: (text: string) => callbacks.onOutput(text),
      onCallEvent,
      onSessionId: threaded
        ? (id: string) => {
            if (resumeId && id !== resumeId) {
              unexpectedResumeSessionId = id;
              return;
            }
            nativeSession.capture(id);
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
      'onOutput' | 'onSessionId' | 'onSessionExpired' | 'onCallEvent' | 'steering'
    >;
    callContext: RunnerCallContext;
    accessMode: 'planning' | 'read-only' | 'write-files';
    images?: readonly Attachment[] | undefined;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
    schema?: TypedSchemaInput | undefined;
  }): Promise<RunnerCallResult> {
    const { prompt, projectDir, callbacks, callContext, accessMode, signal, sandboxEnv, schema } =
      opts;
    const shouldGuardMutations = accessMode !== 'write-files';
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

    // Only a planning call is a turn on the planner's thread. A review, a hint and an escalation
    // are one stateless call each, as Claude Code's are, and leave no session behind.
    const threaded = supportsSessionResume && accessMode === 'planning';
    const resumeId = threaded ? nativeSession.getResumeId() : null;
    const run = (o: Parameters<typeof runOnce>[0]): Promise<RunnerCallResult> =>
      schema === undefined
        ? runOnce(o)
        : adapter.schemaFile
          ? withSchemaFile(schema.json, (path) =>
              runOnce({ ...o, schema: { json: schema.json, path } }),
            )
          : runOnce({ ...o, schema: { json: schema.json } });
    try {
      return await finish(
        await run({
          prompt,
          projectDir,
          callbacks,
          callContext,
          mode: adapterMode,
          threaded,
          resumeId,
          ...(opts.images !== undefined && { images: opts.images }),
          signal,
          sandboxEnv: environment,
        }),
      );
    } catch (err) {
      if (resumeId !== null && isSessionExpiredError(err)) {
        nativeSession.capture(null);
        callbacks.onSessionExpired?.(resumeId);
      }
      throw err;
    }
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks, callContext, images, signal, schema }) =>
      invoke({
        prompt,
        projectDir,
        callbacks,
        callContext,
        accessMode: 'planning',
        ...(images !== undefined && { images }),
        signal,
        ...(schema !== undefined && { schema }),
      }),
    invokeEscalate: ({
      prompt,
      projectDir,
      callbacks,
      callContext,
      accessMode,
      images,
      signal,
      sandboxEnv,
      schema,
    }) =>
      invoke({
        prompt,
        projectDir,
        callbacks,
        callContext,
        accessMode,
        ...(images !== undefined && { images }),
        signal,
        sandboxEnv,
        ...(schema !== undefined && { schema }),
      }),
    runnerName: plannerCfg.tool,
    axes: seatAxisWords(plannerCfg),
    ...(resolvedModel !== undefined && { model: resolvedModel }),
    escalateFullMode: 'files',
    typedOutput: typedOutputCapability(plannerCfg.tool, trustedCli?.installedVersion),

    ...createCommandAvailability(adapter.descriptor.executableAliases, {
      timeout: adapter.probe.version.timeoutMs,
    }),

    capabilities: {
      ...ONE_SHOT_API_CAPS,
      supportsSessionResume,
      supportsEffort,
      supportsImages: seatSupportsImages({ runner: plannerCfg }),
    },
  });
}
