import type {
  Planner,
  PlannerCallbacks,
  PlannerCapabilities,
  PlannerInvokeResult,
} from './types.js';
import { createPlannerBase, type PlannerBaseConfig } from './base.js';
import {
  invokeCommandBasedRunner,
  invokeCustomCommandBasedRunner,
} from '../runners/command-based.js';
import { COMPILER_SUPPORT_TABLE } from '../runners/compiler-capability.js';
import { extractQuestionsFromStream } from '../parsers/question.js';
import { createCommandExistsAvailability, DEFAULT_AVAILABILITY } from '../availability.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { RunnerCallResult } from '../calls/types.js';
import {
  PLANNER_ARTIFACT_MAX_BYTES,
  DECLARED_PLANNER_ARTIFACT_PATH_ENV,
  type DeclaredArtifactProvenance,
  type CustomRunnerRuntimePort,
  type PreparedDeclaredArtifactReview,
} from '../runners/types.js';
import type { AdmittedCustomRunnerInvocation } from '../runners/trust.js';
import type { ConfiguredCustomRunner } from '../runners/custom-trust.js';
import { resolveCustomRunnerEnvironment } from '../runners/redaction.js';
import {
  TaskCompilationAttemptIdSchema,
  TaskCompilationSemanticIdSchema,
} from '../../core/schemas/task-compilation.js';
import { error } from '../../utils/error.js';

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

/** Legacy `shell` and `agent` planner rows that are typed-unsupported in V1. */
export type LegacyCommandPlannerBackend = 'agent' | 'shell';

export type LegacyCommandInvokeOptions = Readonly<{
  command: string;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  notFoundMessage: string;
  backendId?: LegacyCommandPlannerBackend | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}>;

export type LegacyCommandInvokeInput = Readonly<{
  prompt: string;
  projectDir: string;
  callContext: RunnerCallContext;
  callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onCallEvent'>;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
}>;

function isCompilerGradeContext(callContext: RunnerCallContext): boolean {
  return (
    callContext.transport?.kind === 'declared-file' ||
    callContext.envelope !== undefined ||
    callContext.operationEnvelope !== undefined ||
    callContext.sessionScope?.kind === 'detached-fresh'
  );
}

function legacyCompilerRefusal(
  callContext: RunnerCallContext,
  backendId: LegacyCommandPlannerBackend | undefined,
): RunnerCallResult | null {
  if (!isCompilerGradeContext(callContext)) return null;
  const row = backendId === undefined ? undefined : COMPILER_SUPPORT_TABLE[backendId];
  const reason =
    row?.unsupportedReason ??
    'legacy command planners lack compiler containment, final-response, and envelope conformance in V1';
  const backend = backendId ?? 'legacy command';
  return {
    callId: callContext.callId,
    attemptId: callContext.attemptId,
    role: callContext.role,
    backendKind: callContext.backendKind ?? 'cli',
    status: 'unsupported_tool',
    terminalStatus: 'unsupported_tool',
    failureCode: 'task_compiler_capability_unsupported',
    error: {
      code: 'task_compiler_capability_unsupported',
      message: `Compiler dispatch is not supported for the ${backend} planner in V1: ${reason}`,
    },
    partial: false,
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  };
}

export function createLegacyCommandInvoke(
  options: LegacyCommandInvokeOptions,
): (input: LegacyCommandInvokeInput) => Promise<RunnerCallResult> {
  return async (input) => {
    const refusal = legacyCompilerRefusal(input.callContext, options.backendId);
    if (refusal !== null) return refusal;

    const result = await invokeCommandBasedRunner({
      command: options.command,
      args: options.args ?? [],
      outputFormat: options.outputFormat ?? 'text',
      notFoundMessage: options.notFoundMessage,
      prompt: input.prompt,
      projectDir: input.projectDir,
      env: input.sandboxEnv,
      onOutput: input.callbacks.onOutput,
      onCallEvent: input.callbacks.onCallEvent,
      callContext: input.callContext,
      signal: input.signal,
      ...(options.idleWarnMs !== undefined && { idleWarnMs: options.idleWarnMs }),
      ...(options.idleKillMs !== undefined && { idleKillMs: options.idleKillMs }),
    });

    if (input.callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(result.stdout);
      if (questions.length > 0) {
        input.callbacks.onQuestion(questions);
      }
    }

    return result.callResult;
  };
}

export function createCommandBasedPlanner(
  config: {
    command: string;
    args?: string[] | undefined;
    outputFormat?: OutputFormat | undefined;
    idleWarnMs?: number | undefined;
    idleKillMs?: number | undefined;
    compilerBackend?: LegacyCommandPlannerBackend | undefined;
  },
  label: string,
  overrides?: {
    capabilities?: PlannerCapabilities | undefined;
    escalateFullMode?: PlannerBaseConfig['escalateFullMode'] | undefined;
    notFoundMessage?: string | undefined;
  },
): Planner {
  const notFoundMessage =
    overrides?.notFoundMessage ?? `${label} command not found: ${config.command}`;
  const invoke = createLegacyCommandInvoke({
    command: config.command,
    args: config.args,
    outputFormat: config.outputFormat,
    notFoundMessage,
    ...(config.compilerBackend !== undefined && { backendId: config.compilerBackend }),
    ...(config.idleWarnMs !== undefined && { idleWarnMs: config.idleWarnMs }),
    ...(config.idleKillMs !== undefined && { idleKillMs: config.idleKillMs }),
  });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'cli',
    runnerName: config.command,
    hintSuccessMode: 'files',
    capabilities: resolveCapabilities(overrides?.capabilities),
    ...(overrides?.escalateFullMode && { escalateFullMode: overrides.escalateFullMode }),
    ...createCommandExistsAvailability(config.command),
  });
}

function declaredArtifactPrompt(prompt: string, provenance: DeclaredArtifactProvenance): string {
  return `${prompt}\n\nStdout is diagnostic only. Write the complete result to ${provenance.relativePath}. The result must not exceed ${provenance.maxBytes} bytes.`;
}

function declaredArtifactProvenance(
  callContext: RunnerCallContext,
  artifactFile: string | undefined,
): DeclaredArtifactProvenance {
  const attemptId = TaskCompilationAttemptIdSchema.safeParse(callContext.attemptId);
  if (!attemptId.success) {
    throw error(
      'custom-planner-artifact-invalid',
      'Configured custom planner invocation is missing a canonical attempt identity.',
    );
  }
  const relativePath = `.splitbrief-runner/output/${attemptId.data}/result`;
  return {
    semanticId: TaskCompilationSemanticIdSchema.parse(
      `planner-artifact-${artifactFile ?? 'result'}`,
    ),
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

function assertReceiptCapableReview(prepared: PreparedDeclaredArtifactReview): void {
  if (
    typeof prepared.readWithReceiptAfterChild !== 'function' ||
    typeof prepared.getReceipt !== 'function'
  ) {
    throw error(
      'custom-planner-artifact-invalid',
      'Configured custom planner runtime does not support receipt-bound artifact review.',
    );
  }
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
    artifactFile,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onCallEvent'>;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
    artifactFile?: string | undefined;
  }): Promise<PlannerInvokeResult> => {
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
          const provenance = declaredArtifactProvenance(callContext, artifactFile);
          prepared = await runtime.beginDeclaredArtifactReview({
            stagedProjectDir: staged.projectDir,
            callId: callContext.callId,
            declaredRedactionValues: environment.redactionValues,
            provenance,
          });
          assertReceiptCapableReview(prepared);
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
            ownedArtifactReceipt: receipt,
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
