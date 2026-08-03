import type { Planner, PlannerCallbacks, PlannerCapabilities } from './types.js';
import { createPlannerBase, type PlannerBaseConfig } from './base.js';
import {
  invokeCommandBasedRunner,
  invokeCustomCommandBasedRunner,
} from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question.js';
import { createCommandExistsAvailability, DEFAULT_AVAILABILITY } from '../availability.js';
import type { OutputFormat, Phase } from '../../core/schemas/enums.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { RunnerCallResult } from '../calls/types.js';
import {
  DECLARED_PLANNER_ARTIFACT_PATH,
  PLANNER_ARTIFACT_MAX_BYTES,
  type CustomRunnerRuntimePort,
  type PreparedDeclaredArtifactReview,
} from '../runners/types.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import { customRunnerAdmissionError } from '../runners/trust.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import { resolveCustomRunnerEnvironment } from '../runners/redaction.js';

export function resolveCapabilities(
  override: { [K in keyof PlannerCapabilities]?: boolean | undefined } | undefined,
): PlannerCapabilities {
  return {
    supportsConversationalPlanning: override?.supportsConversationalPlanning ?? false,
    supportsHintEscalation: override?.supportsHintEscalation ?? false,
    supportsSessionResume: override?.supportsSessionResume ?? false,
    supportsEffort: override?.supportsEffort ?? false,
    supportsImages: override?.supportsImages ?? false,
    supportsSelfSummarisation: override?.supportsSelfSummarisation ?? false,
  };
}

export function createCommandBasedPlanner(
  config: {
    command: string;
    args?: string[] | undefined;
    outputFormat?: OutputFormat | undefined;
    idleWarnMs?: number | undefined;
    idleKillMs?: number | undefined;
  },
  label: string,
  overrides?: {
    readPhaseOutput?: PlannerBaseConfig['readPhaseOutput'] | undefined;
    capabilities?: PlannerCapabilities | undefined;
    escalateFullMode?: PlannerBaseConfig['escalateFullMode'] | undefined;
    notFoundMessage?: string | undefined;
  },
): Planner {
  const notFoundMessage =
    overrides?.notFoundMessage ?? `${label} command not found: ${config.command}`;
  const invoke = async ({
    prompt,
    projectDir,
    callbacks,
    signal,
    sandboxEnv,
    callContext,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onCallEvent'>;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> => {
    const result = await invokeCommandBasedRunner({
      command: config.command,
      args: config.args ?? [],
      outputFormat: config.outputFormat ?? 'text',
      notFoundMessage,
      prompt,
      projectDir,
      env: sandboxEnv,
      onOutput: callbacks.onOutput,
      onCallEvent: callbacks.onCallEvent,
      callContext,
      signal,
      ...(config.idleWarnMs !== undefined && { idleWarnMs: config.idleWarnMs }),
      ...(config.idleKillMs !== undefined && { idleKillMs: config.idleKillMs }),
    });

    if (callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(result.stdout);
      if (questions.length > 0) {
        callbacks.onQuestion(questions);
      }
    }

    return result.callResult;
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'cli',
    runnerName: config.command,
    hintSuccessMode: 'files',
    capabilities: resolveCapabilities(overrides?.capabilities),
    ...(overrides?.escalateFullMode && { escalateFullMode: overrides.escalateFullMode }),
    ...(overrides?.readPhaseOutput && { readPhaseOutput: overrides.readPhaseOutput }),
    ...createCommandExistsAvailability(config.command),
  });
}

function plannerAdmissionPhase(role: RunnerCallContext['role']): Phase {
  switch (role) {
    case 'escalation':
      return 'escalating';
    case 'review':
      return 'final-review';
    default:
      return 'planning';
  }
}

function declaredArtifactPrompt(prompt: string): string {
  return `${prompt}\n\nStdout is diagnostic only. Write the complete result to ${DECLARED_PLANNER_ARTIFACT_PATH}. The result must not exceed ${PLANNER_ARTIFACT_MAX_BYTES} bytes.`;
}

/**
 * Runs a configured custom planner only after its per-call admission.
 * Output-contract calls discard a child stage; direct normal calls return one
 * reviewed declared artifact, while direct full escalation writes only to the
 * supplied outer stage for the existing diff gate to review.
 */
export function createConfiguredCustomPlanner(
  runner: ConfiguredCustomRunner,
  runtime: CustomRunnerRuntimePort,
): Planner {
  const direct = runner.command.contract === 'direct';
  const posture = customRunnerSecurityPosture('planner', runner.command.contract);

  const invoke = async ({
    prompt,
    projectDir,
    callbacks,
    signal,
    callContext,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onCallEvent'>;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> => {
    const requiresDeclaredArtifactReview = direct && callContext.role !== 'escalation';
    await runtime.cleanupStaleArtifactReviews();

    try {
      const authorizationPathEnv = runtime.authorizationPathEnv ?? '';
      const authorizationPathExt = runtime.authorizationPathExt ?? '';
      const admission = await prepareCustomRunnerAdmission({
        ...runtime.admission,
        projectDir: runtime.authorizationProjectDir,
        runner,
        posture,
        phase: plannerAdmissionPhase(callContext.role),
        authorizationPathEnv,
        authorizationPathExt,
      });
      if (admission.kind !== 'admitted') {
        throw customRunnerAdmissionError.denied('planner');
      }

      const invokeAdmittedRunner = ({
        cwd,
        childPrompt,
      }: Readonly<{
        cwd: string;
        childPrompt: string;
      }>) =>
        invokeCustomCommandBasedRunner({
          admission: admission.invocation,
          prompt: childPrompt,
          authorizationProjectDir: runtime.authorizationProjectDir,
          authorizationPathEnv,
          authorizationPathExt,
          cwd,
          sourceEnv: runtime.sourceEnv,
          onOutput: callbacks.onOutput,
          onCallEvent: callbacks.onCallEvent,
          callContext,
          signal,
        });

      if (direct && callContext.role === 'escalation') {
        return invokeAdmittedRunner({ cwd: projectDir, childPrompt: prompt });
      }

      const staged = await runtime.createStage(projectDir, 'planner');
      try {
        if (!direct) {
          return await invokeAdmittedRunner({ cwd: staged.projectDir, childPrompt: prompt });
        }

        const environment = resolveCustomRunnerEnvironment(runtime.sourceEnv, runner.command.env);
        let prepared: PreparedDeclaredArtifactReview | undefined;
        try {
          prepared = await runtime.beginDeclaredArtifactReview({
            stagedProjectDir: staged.projectDir,
            callId: callContext.callId,
            declaredRedactionValues: environment.redactionValues,
          });
          const result = await invokeAdmittedRunner({
            cwd: staged.projectDir,
            childPrompt: declaredArtifactPrompt(prompt),
          });
          if (result.status !== 'completed') return result;

          return { ...result, text: await prepared.reviewAfterChild() };
        } finally {
          if (prepared !== undefined) await prepared.dispose();
        }
      } finally {
        staged.cleanup();
      }
    } finally {
      if (requiresDeclaredArtifactReview) {
        await runtime.cleanupStaleArtifactReviews();
      }
    }
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: direct ? 'agent' : 'shell',
    runnerName: runner.command.label,
    capabilities: resolveCapabilities(undefined),
    ...(direct && { escalateFullMode: 'files' as const }),
    ...DEFAULT_AVAILABILITY,
  });
}
