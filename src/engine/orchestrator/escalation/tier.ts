import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ApiImplementerConfig } from '../../../core/schemas/implementer-config.js';
import { hasApiBase } from '../../../core/config/accessors/runner-config.js';
import { getProviderBaseURL } from '../../../core/providers/catalog.js';
import type { Implementer } from '../../implementers/types.js';
import { createImplementer } from '../../runners/factory.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import {
  createBusTextHandler,
  createImplementerPublisher,
  publishError,
  publishEscalate,
  publishPlannerStatus,
  publishWarning,
  publishWarningFromError,
} from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { createStagedProject } from '../approval/staged-project.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { runRetryStep } from './step.js';
import {
  MAX_HINT_ERROR_LENGTH,
  failedRetry,
  type EscalationContext,
  type RetryResult,
  type RetryStepOutcome,
} from './types.js';
import type { GateAndPromoteOutcome } from '../approval/gate-and-promote.js';

type TierConfig =
  | { tier: 0; kind: 'intermediate' }
  | { tier: 1; kind: 'hint' }
  | { tier: 2; kind: 'full' };

export const INTERMEDIATE_TIER: TierConfig = { tier: 0, kind: 'intermediate' };
export const HINT_TIER: TierConfig = { tier: 1, kind: 'hint' };
export const FULL_TIER: TierConfig = { tier: 2, kind: 'full' };

type TierStepInput = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  priorAttempts: number;
};

export async function runEscalationTier(
  config: TierConfig,
  input: TierStepInput,
): Promise<RetryStepOutcome> {
  if (config.kind === 'intermediate') {
    return runIntermediateTier(input);
  }
  if (config.kind === 'hint') {
    return runHintTier(input);
  }
  const outcome = await runFullTier(input);
  return {
    ...outcome,
    task: input.task,
    lastError: input.lastError,
    attempts: input.priorAttempts + 1,
  };
}

async function runIntermediateTier(input: TierStepInput): Promise<RetryStepOutcome> {
  const { ctx, task: initialTask, state, lastError, priorAttempts } = input;
  const escalation = ctx.config.escalation;
  if (!escalation?.intermediateProvider || escalation.enabled === false) {
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  const attempts = priorAttempts + 1;
  const textHandler = createBusTextHandler({ bus: ctx.bus, phase: state.phase });
  publishEscalate({
    bus: ctx.bus,
    phase: state.phase,
    taskId: initialTask.id,
    tier: 0,
    tool: escalation.intermediateProvider,
    model: escalation.intermediateModel ?? ctx.config.implementer.model,
  });

  const intermediateConfig = resolveIntermediateConfig(ctx, state);
  if (!intermediateConfig) return { state, task: initialTask, lastError, attempts: priorAttempts };

  let intermediateImplementer: Implementer;
  try {
    intermediateImplementer = await createImplementer(intermediateConfig, {
      publisher: createImplementerPublisher(ctx.bus),
    });
  } catch (err) {
    publishWarningFromError(
      { bus: ctx.bus, phase: state.phase },
      'Intermediate provider failed to initialize',
      err,
    );
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  return runRetryStep({
    ctx,
    task: initialTask,
    state,
    lastError,
    attempts,
    method: 'escalated-intermediate',
    transitionType: 'VALIDATION_PASS',
    commitSuffix: 'intermediate',
    usageCategory: 'implementer',
    retryFailureFallback: 'Intermediate escalation failed',
    invokeRetry: async ({
      task: t,
      lastError: err,
      attempts: a,
      projectDir,
      signal,
      sandboxEnv,
      fileIgnoreProjectDir,
    }) =>
      intermediateImplementer.retry({
        task: t,
        projectDir,
        config: intermediateConfig,
        context: ctx.context,
        languageContext: buildProjectLanguageContext(
          ctx.projectDir,
          state.discoveredValidation?.language,
        ),
        error: err,
        attempt: a,
        kind: 'local',
        onOutput: textHandler,
        phase: state.phase,
        signal,
        sandboxEnv,
        fileIgnoreProjectDir,
      }),
  });
}

function resolveIntermediateConfig(ctx: EscalationContext, state: WorkflowState): Config | null {
  const escalation = ctx.config.escalation;
  if (!escalation?.intermediateProvider) return null;
  const resolvedApiBase = getProviderBaseURL(escalation.intermediateProvider);
  if (!resolvedApiBase) {
    publishWarning(
      { bus: ctx.bus, phase: state.phase },
      `Unknown intermediate provider "${escalation.intermediateProvider}" — falling back to current implementer endpoint`,
    );
  }

  const currentApiBase = hasApiBase(ctx.config.implementer)
    ? ctx.config.implementer.apiBase
    : undefined;
  const effectiveApiBase = resolvedApiBase || currentApiBase;
  if (!effectiveApiBase) {
    publishWarning(
      { bus: ctx.bus, phase: state.phase },
      `Cannot escalate: no API base URL available for intermediate provider "${escalation.intermediateProvider}"`,
    );
    return null;
  }

  const intermediateImplConfig: ApiImplementerConfig = {
    kind: 'api',
    provider: escalation.intermediateProvider,
    model: escalation.intermediateModel ?? ctx.config.implementer.model,
    apiBase: effectiveApiBase,
    contextLength: ctx.config.implementer.contextLength,
    temperature: ctx.config.implementer.temperature,
    timeout: ctx.config.implementer.timeout,
    customModels: ctx.config.implementer.customModels,
  };

  return {
    ...ctx.config,
    implementer: intermediateImplConfig,
  };
}

async function runHintTier(input: TierStepInput): Promise<RetryStepOutcome> {
  const { ctx, task: initialTask, lastError, priorAttempts } = input;
  let state = input.state;
  const attempts = priorAttempts + 1;
  const textHandler = createBusTextHandler({ bus: ctx.bus, phase: state.phase });
  if (state.phase === 'implementing') {
    state = transitionAndSave(ctx, state, { type: 'TASK_SENT' });
  }
  state = transitionAndSave(ctx, state, { type: 'ESCALATE' });
  publishPlannerStatus(ctx.bus, state, 'running');
  ctx.bus.publish({
    type: 'task_escalating',
    ts: Date.now(),
    phase: state.phase,
    taskId: initialTask.id,
  });

  publishEscalate({ bus: ctx.bus, phase: state.phase, taskId: initialTask.id, tier: 1 });
  const languageContext = buildProjectLanguageContext(
    ctx.projectDir,
    state.discoveredValidation?.language,
  );
  const staged = await createStagedProject(ctx.projectDir);
  let tier1Result: Awaited<ReturnType<typeof ctx.planner.escalateHint>>;
  try {
    tier1Result = await ctx.planner.escalateHint({
      task: initialTask,
      error: lastError,
      projectDir: staged.projectDir,
      callbacks: {
        onOutput: textHandler,
        signal: ctx.signal,
      },
      languageContext,
      sandboxEnv: staged.sandboxEnv,
      fileIgnoreProjectDir: ctx.projectDir,
    });
  } catch (err) {
    staged.cleanup();
    throw err;
  }
  state = addUsageAndSave(ctx, state, 'escalation', tier1Result.usage);

  const gateResult = await gateAndPromoteChangedFiles({
    task: initialTask,
    state,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    bus: ctx.bus,
    callbacks: ctx.callbacks,
    config: ctx.config,
    staged,
    usesStaging: true,
    taskStartSnapshot: ctx.taskStartSnapshot,
    dependsOnFiles: ctx.dependsOnFiles,
    promoteFromStagingOnly: true,
    catchChangedFilesError: true,
    signal: ctx.signal,
    cleanup: staged.cleanup,
    handleConflict: (s, files) =>
      handleApprovalTimeUserEditConflict({ ctx, state: s, task: initialTask, files }),
    onApproved: (decision) => persistRetryApprovalEvidence(ctx, state, initialTask, decision),
  });
  const gateBlocked = handleHintTierGateOutcome({
    ctx,
    task: initialTask,
    lastError,
    attempts,
    gateResult,
  });
  if (gateBlocked) return gateBlocked;
  state = gateResult.state;

  if (tier1Result.output) {
    textHandler(tier1Result.output);
  }

  const hintError = truncateByChars(
    `${lastError}\n\n## Hints from senior reviewer:\n${tier1Result.output}`,
    MAX_HINT_ERROR_LENGTH,
  );

  return runRetryStep({
    ctx,
    task: initialTask,
    state,
    lastError: hintError,
    attempts,
    method: 'escalated-hint',
    transitionType: 'HINT_SUCCESS',
    commitSuffix: 'with hints',
    usageCategory: 'implementer',
    retryFailureFallback: 'Tier-1 hint retry failed to produce valid code',
    profileOverride: ctx.retryProfileOverride,
    invokeRetry: async ({
      task: t,
      lastError: err,
      attempts: a,
      projectDir,
      implementer,
      config,
      signal,
      sandboxEnv,
      fileIgnoreProjectDir,
    }) =>
      implementer.retry({
        task: t,
        projectDir,
        config,
        context: ctx.context,
        languageContext,
        error: err,
        attempt: a,
        kind: 'hint',
        onOutput: textHandler,
        phase: state.phase,
        signal,
        sandboxEnv,
        fileIgnoreProjectDir,
      }),
  });
}

function handleHintTierGateOutcome(input: {
  ctx: EscalationContext;
  task: Task;
  lastError: string;
  attempts: number;
  gateResult: GateAndPromoteOutcome;
}): RetryStepOutcome | null {
  const { ctx, task, lastError, attempts, gateResult } = input;
  if (gateResult.outcome === 'allow') return null;
  if (gateResult.outcome === 'error') throw gateResult.error;
  if (gateResult.outcome === 'aborted') {
    return {
      state: gateResult.state,
      task,
      lastError,
      attempts,
      result: failedRetry(attempts),
    };
  }
  if (gateResult.outcome === 'gate-denied') {
    const files = gateResult.decision.changedFiles.join(', ');
    const reason = gateResult.decision.reason ?? 'denied';
    publishError(
      { bus: ctx.bus, phase: gateResult.state.phase },
      `Hint-tier changed files blocked by approval gate: ${reason} (${files})`,
    );
    persistRetryRejectionEvidence(ctx, gateResult.state, task, gateResult.decision);
    return {
      state: gateResult.state,
      task,
      lastError: reason,
      attempts,
      result: failedRetry(attempts),
    };
  }
  const reason = `Hint-tier promotion blocked because files changed during approval: ${gateResult.conflictedFiles.join(', ')}`;
  publishError({ bus: ctx.bus, phase: gateResult.state.phase }, reason);
  return {
    state: gateResult.state,
    task,
    lastError: reason,
    attempts,
    result: failedRetry(attempts),
  };
}

async function runFullTier(
  input: TierStepInput,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const { ctx, task: initialTask, lastError, priorAttempts } = input;
  let state = input.state;
  const attempts = priorAttempts + 1;
  const textHandler = createBusTextHandler({ bus: ctx.bus, phase: state.phase });
  state = transitionAndSave(ctx, state, { type: 'HINT_FAIL' });
  ctx.bus.publish({
    type: 'hint_failed',
    ts: Date.now(),
    phase: state.phase,
    taskId: initialTask.id,
  });

  publishEscalate({ bus: ctx.bus, phase: state.phase, taskId: initialTask.id, tier: 2 });
  const languageContext = buildProjectLanguageContext(
    ctx.projectDir,
    state.discoveredValidation?.language,
  );

  const outcome = await runRetryStep({
    ctx,
    task: initialTask,
    state,
    lastError,
    attempts,
    method: 'escalated-full',
    transitionType: 'FULL_SUCCESS',
    commitSuffix: 'escalated',
    usageCategory: 'escalation',
    retryFailureFallback: 'Tier-2 escalation failed to produce valid code',
    invokeRetry: async ({
      task: t,
      lastError: err,
      projectDir,
      signal,
      sandboxEnv,
      fileIgnoreProjectDir,
    }) =>
      ctx.planner.escalateFull({
        task: t,
        error: err,
        projectDir,
        callbacks: { onOutput: textHandler, signal },
        languageContext,
        sandboxEnv,
        fileIgnoreProjectDir,
      }),
    onValidationAfterRetryFail: (validationError) => {
      publishWarning(
        { bus: ctx.bus, phase: state.phase },
        `Tier-2 escalation produced code but validation failed: ${validationError}`,
      );
    },
  });

  if (outcome.result) {
    return { state: outcome.state, result: outcome.result };
  }

  ctx.bus.publish({
    type: 'task_full_fail',
    ts: Date.now(),
    phase: outcome.state.phase,
    taskId: outcome.task.id,
  });
  return { state: outcome.state, result: failedRetry(attempts) };
}
