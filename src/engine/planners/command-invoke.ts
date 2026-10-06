import type { Planner, PlannerCallbacks, PlannerCapabilities } from './types.js';
import { createPlannerBase, type PlannerBaseConfig } from './base.js';
import {
  invokeCommandBasedRunner,
  invokeCustomCommandBasedRunner,
} from '../runners/command-based.js';
import { createCommandExistsAvailability, DEFAULT_AVAILABILITY } from '../availability.js';
import type { AgentPlannerConfig, ShellPlannerConfig } from '../../core/schemas/planner-config.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { RunnerCallResult } from '../calls/types.js';
import {
  PLANNER_ARTIFACT_MAX_BYTES,
  DECLARED_PLANNER_ARTIFACT_PATH_ENV,
  type DeclaredArtifactProvenance,
  type CustomRunnerRuntimePort,
  type PreparedDeclaredArtifactReview,
} from '../runners/types.js';
import type { AdmittedCustomRunnerInvocation } from '../runners/custom-launchability.js';
import type { ConfiguredCustomRunner } from '../runners/custom-trust.js';
import { resolveCustomRunnerEnvironment } from '../runners/redaction.js';
import { createRunnerSandboxEnv } from '../runners/sandbox-env.js';
import {
  PlannerArtifactAttemptIdSchema,
  PlannerArtifactSemanticIdSchema,
} from '../../core/schemas/planner-artifact.js';
import { error } from '../../utils/error.js';

export function resolveCapabilities(
  override: { [K in keyof PlannerCapabilities]?: boolean | undefined } | undefined,
): PlannerCapabilities {
  return {
    supportsConversationalPlanning: override?.supportsConversationalPlanning ?? false,
    supportsSessionResume: override?.supportsSessionResume ?? false,
    supportsEffort: override?.supportsEffort ?? false,
    supportsImages: override?.supportsImages ?? false,
    supportsSelfSummarisation: override?.supportsSelfSummarisation ?? false,
  };
}

export type LegacyCommandInvokeOptions = Readonly<{
  runner: ShellPlannerConfig | AgentPlannerConfig;
  notFoundMessage: string;
}>;

export type LegacyCommandInvokeInput = Readonly<{
  prompt: string;
  projectDir: string;
  callContext: RunnerCallContext;
  callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onCallEvent'>;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
}>;

export function createLegacyCommandInvoke(
  options: LegacyCommandInvokeOptions,
): (input: LegacyCommandInvokeInput) => Promise<RunnerCallResult> {
  const { runner } = options;
  return async (input) => {
    const result = await invokeCommandBasedRunner({
      command: runner.command,
      args: runner.args ?? [],
      outputFormat: runner.outputFormat ?? 'text',
      notFoundMessage: options.notFoundMessage,
      prompt: input.prompt,
      projectDir: input.projectDir,
      env: input.sandboxEnv ?? (await createRunnerSandboxEnv(input.projectDir, runner, 'planner')),
      onOutput: input.callbacks.onOutput,
      onCallEvent: input.callbacks.onCallEvent,
      callContext: input.callContext,
      signal: input.signal,
      ...(runner.idleWarnMs !== undefined && { idleWarnMs: runner.idleWarnMs }),
      ...(runner.idleKillMs !== undefined && { idleKillMs: runner.idleKillMs }),
    });

    return result.callResult;
  };
}

export function createCommandBasedPlanner(
  config: ShellPlannerConfig | AgentPlannerConfig,
  label: string,
  overrides?: {
    capabilities?: PlannerCapabilities | undefined;
    escalateFullMode?: PlannerBaseConfig['escalateFullMode'] | undefined;
    notFoundMessage?: string | undefined;
  },
): Planner {
  const notFoundMessage =
    overrides?.notFoundMessage ?? `${label} command not found: ${config.command}`;
  const invoke = createLegacyCommandInvoke({ runner: config, notFoundMessage });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'cli',
    runnerName: config.command,
    capabilities: resolveCapabilities(overrides?.capabilities),
    ...(overrides?.escalateFullMode && { escalateFullMode: overrides.escalateFullMode }),
    ...createCommandExistsAvailability(config.command),
  });
}

function declaredArtifactPrompt(prompt: string, provenance: DeclaredArtifactProvenance): string {
  return `${prompt}\n\nStdout is diagnostic only. Write the complete result to ${provenance.relativePath}. The result must not exceed ${provenance.maxBytes} bytes.`;
}

function declaredArtifactProvenance(callContext: RunnerCallContext): DeclaredArtifactProvenance {
  const attemptId = PlannerArtifactAttemptIdSchema.safeParse(callContext.attemptId);
  if (!attemptId.success) {
    throw error(
      'custom-planner-artifact-invalid',
      'Configured custom planner invocation is missing a canonical attempt identity.',
    );
  }
  const relativePath = `.splitbrief-runner/output/${attemptId.data}/result`;
  return {
    semanticId: PlannerArtifactSemanticIdSchema.parse('planner-artifact-result'),
    programId: null,
    batchId: null,
    attemptId: attemptId.data,
    transport: {
      kind: 'declared-file',
      lease: { leaseId: attemptId.data, attemptId: attemptId.data, relativePath },
    },
    maxBytes: PLANNER_ARTIFACT_MAX_BYTES,
    relativePath,
  };
}

/**
 * Runs a configured custom planner with preparation-time admission.
 * Output-contract calls discard a child stage; direct normal calls return one
 * reviewed declared artifact, while direct full escalation writes only to the
 * supplied outer stage for the existing diff gate to review.
 */
export function createConfiguredCustomPlanner(
  runner: ConfiguredCustomRunner,
  runtime: CustomRunnerRuntimePort,
  admission: AdmittedCustomRunnerInvocation,
): Planner {
  const direct = runner.command.contract === 'direct';

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
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onCallEvent'>;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> => {
    const requiresDeclaredArtifactReview = direct && callContext.role !== 'escalation';
    await runtime.cleanupStaleArtifactReviews();

    try {
      const authorizationPathEnv = runtime.authorizationPathEnv ?? '';
      const authorizationPathExt = runtime.authorizationPathExt ?? '';
      const invokeAdmittedRunner = ({
        cwd,
        childPrompt,
        sourceEnv,
      }: Readonly<{
        cwd: string;
        childPrompt: string;
        sourceEnv?: NodeJS.ProcessEnv | undefined;
      }>) =>
        invokeCustomCommandBasedRunner({
          admission,
          prompt: childPrompt,
          authorizationProjectDir: runtime.authorizationProjectDir,
          authorizationPathEnv,
          authorizationPathExt,
          cwd,
          sourceEnv: sourceEnv ?? runtime.sourceEnv,
          ...(sourceEnv === undefined
            ? {}
            : { preserveEnvironmentKeys: [DECLARED_PLANNER_ARTIFACT_PATH_ENV] }),
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
          const provenance = declaredArtifactProvenance(callContext);
          prepared = await runtime.beginDeclaredArtifactReview({
            stagedProjectDir: staged.projectDir,
            callId: callContext.callId,
            declaredRedactionValues: environment.redactionValues,
            provenance,
          });
          const result = await invokeAdmittedRunner({
            cwd: staged.projectDir,
            childPrompt: declaredArtifactPrompt(prompt, provenance),
            sourceEnv: {
              ...runtime.sourceEnv,
              [DECLARED_PLANNER_ARTIFACT_PATH_ENV]: provenance.relativePath,
            },
          });
          if (result.status !== 'completed') return result;

          const text = await prepared.reviewAfterChild();
          const reviewed = await prepared.readWithReceiptAfterChild();
          const receipt = prepared.getReceipt();
          if (
            receipt === undefined ||
            reviewed.text !== text ||
            receipt.leaseReceiptDigest !== reviewed.receipt.leaseReceiptDigest
          ) {
            throw error(
              'custom-planner-artifact-invalid',
              'Configured custom planner artifact review completed without a lease receipt.',
            );
          }
          return {
            ...result,
            attemptId: provenance.attemptId,
            transport: provenance.transport,
            text,
          };
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
