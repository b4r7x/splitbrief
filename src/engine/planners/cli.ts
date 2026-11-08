import type { Config } from '../../core/schemas/config.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { Planner, PlannerCallbacks, PlannerFactoryOptions } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandExistsAvailability } from '../availability.js';
import { invokeCliAdapter, toCliEnvironment } from '../runners/invoke-cli-adapter.js';
import { lookupCliPlannerAdapter } from '../runners/cli-tools/registry.js';
import { typedOutputCapability } from '../../core/runners/cli-tool-catalog.js';
import { seatSupportsImages } from '../../core/runners/capabilities.js';
import { resolveSeatImageFact } from '../providers/model/resolution.js';
import type { CliSchemaInput } from '../runners/cli-tools/contract.js';
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
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { seatAxisWords } from '../../core/runners/effort-channel.js';
import { callAdmittedCli, requireCliSeat } from '../runners/start-gate.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { withCliInvocationIdentity } from '../runners/invocation-identity.js';

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
  const { config, initialSessionId, cliSeat, modelCache } = opts;
  const plannerCfg = assertPlannerKind(config, 'cli');
  resolveCliRunnerAuth(plannerCfg);
  const resolvedModel = resolveCliModel(plannerCfg.model, plannerCfg.tool);
  const adapter = lookupCliPlannerAdapter(plannerCfg.tool);
  const { supportsSessionResume, supportsEffort } = adapter;

  // The only thread a CLI resumes is one it reported itself. The SPLITBRIEF session
  // id is not a tool thread id, so it never reaches --resume.
  const nativeSession = createSessionResumeState();
  nativeSession.capture(initialSessionId ?? null);

  const effort = plannerCfg.effort;
  const variant = plannerCfg.variant;
  const timeout = plannerCfg.timeout;
  const extraArgs = plannerCfg.args ?? [];

  async function runOnce(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId' | 'onCallEvent' | 'steering'>;
    callContext: RunnerCallContext;
    threaded: boolean;
    resumeId: string | null;
    images?: readonly Attachment[] | undefined;
    signal?: AbortSignal | undefined;
    sandboxEnv: NodeJS.ProcessEnv;
    schema?: CliSchemaInput | undefined;
  }): Promise<RunnerCallResult> {
    const {
      prompt,
      projectDir,
      callbacks,
      callContext,
      threaded,
      resumeId,
      images,
      signal,
      sandboxEnv,
    } = opts;
    let unexpectedResumeSessionId: string | null = null;
    let stderrOutput = '';

    const onCallEvent = (event: RunnerCallEvent): void => {
      if (event.type === 'call_stderr_delta') {
        stderrOutput = `${stderrOutput}${event.text}`.slice(-8_192);
      }
      if (resumeId && isRecoverableResumeNoise(event, resumeId)) return;
      callbacks.onCallEvent?.(event);
    };

    const result = await callAdmittedCli(
      requireCliSeat(plannerCfg.tool, cliSeat),
      signal,
      (executable, gate) => {
        const baseArgs = adapter.baseArgs({
          model: resolvedModel,
          projectDir,
          configuredArgs: extraArgs,
          sessionId: supportsSessionResume ? resumeId : null,
          oneShot: !threaded,
          effort: supportsEffort ? effort : undefined,
          variant,
          installedVersion: gate.installedVersion,
          schema: opts.schema,
          ...(images !== undefined && images.length > 0
            ? { imagePaths: images.map((image) => image.path) }
            : {}),
        });
        return invokeCliAdapter({
          adapter,
          invocation: {
            executable,
            args: [...baseArgs, ...extraArgs],
            baseArgs,
            promptTransport: adapter.promptTransport,
            environment: toCliEnvironment(sandboxEnv),
            cwd: projectDir,
            images,
            timeoutMs: timeout,
            signal,
          },
          prompt,
          steering: callbacks.steering,
          installedVersion: gate.installedVersion,
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
          maxToolCalls: plannerCfg.maxToolCalls,
        });
      },
    );

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
    accessMode: 'planning' | 'read-only';
    images?: readonly Attachment[] | undefined;
    signal?: AbortSignal | undefined;
    schema?: TypedSchemaInput | undefined;
  }): Promise<RunnerCallResult> {
    const { prompt, projectDir, callbacks, callContext, accessMode, signal, schema } = opts;
    const environment = await createRunnerSandboxEnv(projectDir, plannerCfg, 'planner');
    const mutationBaseline = await capturePlanningMutationBaseline(projectDir);

    const finish = async (result: RunnerCallResult): Promise<RunnerCallResult> => {
      const unexpected = await findUnexpectedPlanningMutations({
        projectDir,
        baseline: mutationBaseline,
        internalStatePaths: adapter.descriptor.internalStatePaths,
      });
      if (unexpected.length > 0) {
        throw planningMutationError.unexpectedMutations(unexpected);
      }
      return result;
    };

    // Only a planning call is a turn on the planner's thread. A review and a summary
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
      const result = await run({
        prompt,
        projectDir,
        callbacks,
        callContext,
        threaded,
        resumeId,
        ...(opts.images !== undefined && { images: opts.images }),
        signal,
        sandboxEnv: environment,
      });
      // A thread the tool refused as too long is refused again: the next call starts a fresh one.
      if (threaded && result.status !== 'completed' && result.error?.code === 'input-too-large') {
        nativeSession.capture(null);
      }
      return await finish(result);
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
    invokeOneShot: ({ prompt, projectDir, callbacks, callContext, images, signal, schema }) =>
      invoke({
        prompt,
        projectDir,
        callbacks,
        callContext,
        accessMode: 'read-only',
        ...(images !== undefined && { images }),
        signal,
        ...(schema !== undefined && { schema }),
      }),
    runnerName: plannerCfg.tool,
    axes: seatAxisWords(plannerCfg),
    ...(resolvedModel !== undefined && { model: resolvedModel }),
    typedOutput: typedOutputCapability(plannerCfg.tool, cliSeat?.current().installedVersion),

    ...createCommandExistsAvailability(adapter.descriptor.executableAliases),

    capabilities: {
      ...ONE_SHOT_API_CAPS,
      supportsSessionResume,
      supportsEffort,
      supportsImages: seatSupportsImages({
        runner: plannerCfg,
        detected: resolveSeatImageFact({
          runner: plannerCfg,
          role: 'planner',
          cache: modelCache,
        }),
      }),
    },
  });
}
