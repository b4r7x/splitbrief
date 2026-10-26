import type { Planner, PlannerCallbacks, PlannerCapabilities } from './types.js';
import { createPlannerBase, type PlannerBaseConfig } from './base.js';
import { invokeCommandRunner } from '../runners/command-based.js';
import { createCommandExistsAvailability, DEFAULT_AVAILABILITY } from '../availability.js';
import type { Config } from '../../core/schemas/config.js';
import { assertPlannerKind } from '../config-assertions.js';
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
import { seatAxisWords } from '../../core/runners/effort-channel.js';

function resolveCapabilities(
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

export function createCommandPlanner(config: Config, kind: 'shell' | 'agent'): Planner {
  const runner = assertPlannerKind(config, kind);
  const label = kind === 'shell' ? 'Shell planner' : 'Agent planner';
  const notFoundMessage = `${label} command not found: ${runner.command}`;
  const invoke: PlannerBaseConfig['invokePlan'] = async (input) =>
    invokeCommandRunner({
      source: {
        kind: 'config',
        runner,
        env: await createRunnerSandboxEnv(input.projectDir, runner, 'planner'),
        notFoundMessage,
      },
      prompt: input.prompt,
      cwd: input.projectDir,
      callContext: input.callContext,
      timeoutMs: runner.timeout,
      signal: input.signal,
      onOutput: input.callbacks.onOutput,
      onCallEvent: input.callbacks.onCallEvent,
    });

  return createPlannerBase({
    invokePlan: invoke,
    invokeOneShot: invoke,
    backendKind: runner.kind,
    runnerName: runner.command,
    model: runner.model,
    axes: seatAxisWords(runner),
    capabilities: resolveCapabilities(runner.capabilities),
    ...createCommandExistsAvailability(runner.command),
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
 * Output-contract calls discard a child stage; direct calls return one
 * reviewed declared artifact.
 */
export function createConfiguredCustomPlanner(
  runner: ConfiguredCustomRunner,
  runtime: CustomRunnerRuntimePort,
  admission: AdmittedCustomRunnerInvocation,
  timeoutMs?: number | undefined,
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
  }): Promise<RunnerCallResult> => {
    await runtime.cleanupStaleArtifactReviews();

    try {
      const invokeAdmittedRunner = ({
        cwd,
        childPrompt,
        sourceEnv,
      }: Readonly<{
        cwd: string;
        childPrompt: string;
        sourceEnv?: NodeJS.ProcessEnv | undefined;
      }>) =>
        invokeCommandRunner({
          source: {
            kind: 'admitted',
            admission,
            authorizationProjectDir: runtime.authorizationProjectDir,
            authorizationPathEnv: runtime.authorizationPathEnv,
            authorizationPathExt: runtime.authorizationPathExt,
            sourceEnv: sourceEnv ?? runtime.sourceEnv,
            ...(sourceEnv !== undefined && {
              preserveEnvironmentKeys: [DECLARED_PLANNER_ARTIFACT_PATH_ENV],
            }),
          },
          prompt: childPrompt,
          cwd,
          callContext,
          timeoutMs,
          signal,
          onOutput: callbacks.onOutput,
          onCallEvent: callbacks.onCallEvent,
        });

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
      if (direct) {
        await runtime.cleanupStaleArtifactReviews();
      }
    }
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeOneShot: invoke,
    backendKind: direct ? 'agent' : 'shell',
    runnerName: runner.command.label,
    axes: [],
    capabilities: resolveCapabilities(undefined),
    ...DEFAULT_AVAILABILITY,
  });
}
