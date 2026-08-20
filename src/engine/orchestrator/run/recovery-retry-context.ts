import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  NormalBriefRecoveryV1,
  RecoveryEstimateInput,
} from '../../../core/schemas/brief-recovery.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import { readRecoveryArtifact } from '../../../core/evidence/ledger-storage.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { getEscalatedTaskIds } from '../../../core/state/selectors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { buildTasksPrompt } from '../../spec/prompts/tasks.js';
import { buildBriefQualityRepairComment } from '../planning/regen-targeted.js';
import { estimateBriefRecoveryCall } from '../budget/estimate.js';
import { getBudgetCostKnownness } from '../budget/knownness.js';
import type { WorkflowContext } from '../types.js';

export function retryPrompt(
  wctx: WorkflowContext,
  state: WorkflowState,
  recovery: NormalBriefRecoveryV1,
  frozenInputIds: readonly string[],
  stagedPayloads?: ReadonlyMap<string, unknown>,
): string {
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const tasksText = readSpecFile(ref, TASKS_FILE);
  if (tasksText === null)
    throw error('brief-recovery-input-invalid', 'The current Task Briefs are unavailable.');
  const currentTasks = parseTasksStrict(tasksText);
  const base = buildTasksPrompt(
    readSpecFile(ref, SPEC_FILE) ?? state.feature,
    readSpecFile(ref, PLAN_FILE) ?? '',
    buildProjectLanguageContext(wctx.projectDir, state.discoveredValidation?.language),
    currentTasks,
  );
  const errors =
    recovery.status === 'rejected' || recovery.matchingReport === null
      ? []
      : recovery.matchingReport.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message);
  const feedback = frozenInputIds.map((inputId) => {
    const input = recovery.inputs.find((candidate) => candidate.inputId === inputId);
    if (input === undefined || (input.state !== 'queued' && input.state !== 'carried')) {
      throw error(
        'brief-recovery-input-invalid',
        'The feedback input is no longer available for revision.',
      );
    }
    if (input.payloadRef.revision !== 1) {
      throw error(
        'brief-recovery-input-invalid',
        'The feedback evidence has an unsupported revision.',
      );
    }
    let evidence: ReturnType<typeof narrowRecord>;
    try {
      evidence = narrowRecord(readRecoveryArtifact(ref, { ...input.payloadRef, revision: 1 }));
    } catch {
      evidence = narrowRecord(stagedPayloads?.get(input.payloadRef.path));
    }
    if (
      evidence?.kind !== 'queued-input' ||
      evidence.inputId !== inputId ||
      typeof evidence.payload !== 'string' ||
      sha256Hex(evidence.payload) !== input.textHash
    ) {
      throw error(
        'brief-recovery-input-invalid',
        'The feedback evidence does not match the queued input.',
      );
    }
    return evidence.payload;
  });
  return [
    ...(feedback.length === 0
      ? []
      : [`User feedback for this revision:\n\n${feedback.join('\n\n')}`]),
    ...(errors.length === 0 ? [] : [buildBriefQualityRepairComment(errors)]),
    base,
  ].join('\n\n');
}

export function retryBudgetContext(
  wctx: WorkflowContext,
  state: WorkflowState,
): {
  currentKnownSpend: number;
  maxBudget?: number | undefined;
} {
  const identity = runPricingIdentity(wctx.config);
  const plannerModel = state.plannerModel ?? identity.plannerModel;
  const implementerModel = state.implementerModel ?? identity.implementerModel;
  const knownness = getBudgetCostKnownness({
    tokenUsage: state.tokenUsage,
    totalTasks: state.tasks.length,
    escalatedCount: getEscalatedTaskIds(state).length,
    plannerTool: state.plannerTool ?? identity.plannerTool,
    implementerTool: state.implementerTool ?? identity.implementerTool,
    ...(plannerModel === undefined ? {} : { plannerModel }),
    ...(implementerModel === undefined ? {} : { implementerModel }),
    ...(state.taskBreakdowns === undefined ? {} : { taskBreakdowns: state.taskBreakdowns }),
    ...(wctx.modelCache === undefined ? {} : { pricingCache: wctx.modelCache }),
  });
  if (knownness.hasUnknownPaidUsage && wctx.config.workflow.maxBudget !== undefined) {
    throw error(
      'brief-recovery-budget-unknown',
      knownness.unknownReason ?? 'Recovery budget spend is unknown.',
    );
  }
  return {
    currentKnownSpend: knownness.currentKnownCost,
    ...(wctx.config.workflow.maxBudget === undefined
      ? {}
      : { maxBudget: wctx.config.workflow.maxBudget }),
  };
}

export function estimateRecoveryCall(
  wctx: WorkflowContext,
  state: WorkflowState,
  input: RecoveryEstimateInput,
) {
  const identity = runPricingIdentity(wctx.config);
  const plannerTool = state.plannerTool ?? identity.plannerTool;
  const plannerModel = state.plannerModel ?? identity.plannerModel;
  return estimateBriefRecoveryCall({
    ...input,
    plannerTool,
    ...(plannerModel === undefined ? {} : { plannerModel }),
    ...(wctx.modelCache === undefined ? {} : { pricingCache: wctx.modelCache }),
  });
}
