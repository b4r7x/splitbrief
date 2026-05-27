import type { WorkflowOpts } from '../core/types/config-options.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import { loadConfig } from '../core/config/load/load.js';
import { applyCLIOverrides } from '../core/config/runtime/overrides.js';
import { loadState } from '../core/state/persistence.js';
import { readActive } from '../core/sessions/lifecycle.js';
import { warnStderr } from '../lib/warn.js';
import { runWorkflow } from '../engine/orchestrator/run/run.js';
import { modelCacheStore } from '../stores/discovery/model-cache.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { cliError } from './errors.js';
import { buildCLIOverrides } from './build-overrides.js';
import type { CollectedReadiness } from '../core/readiness/collect.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

function emitRecoveryAndFailIfPending(projectDir: string, sessionId: string | undefined): void {
  const recoverySessionId = sessionId ?? readActive(projectDir);
  if (!recoverySessionId) return;
  const state = loadState(projectDir, recoverySessionId);
  const issue = state?.pendingRecovery;
  if (!issue) return;
  process.stdout.write(JSON.stringify({
    type: 'recovery_required',
    sessionId: recoverySessionId,
    reason: issue.reason,
    message: issue.message,
    taskId: issue.taskId,
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
  }) + '\n');
  throw cliError(`Recovery required: ${issue.message}`, 1);
}

export interface RunHeadlessOptions {
  feature: string;
  projectDir: string;
  opts: WorkflowOpts;
  savedState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  readiness?: CollectedReadiness | undefined;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
  plannerContext?: string | undefined;
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const {
    feature,
    projectDir,
    opts,
    savedState,
    sessionId,
    readiness,
    _planner,
    _implementer,
    plannerContext,
  } = options;
  const loadedResult = readiness?.config
    ? { config: readiness.config, warnings: readiness.warnings }
    : loadConfig(projectDir);
  const { config: loaded, warnings } = loadedResult;
  for (const w of warnings) warnStderr(`⚠ ${w}`);

  const config = applyCLIOverrides(loaded, {
    ...buildCLIOverrides(opts),
    autoApprove: opts.auto !== undefined ? opts.auto : true,
  });

  if (!config) throw cliError('Failed to load config');
  if ((config.workflow.taskReview ?? 'none') !== 'none') {
    throw cliError('workflow.taskReview requires an interactive TUI run. Set workflow.taskReview: none for headless mode.');
  }

  await runWorkflow({
    feature,
    plannerContext,
    projectDir,
    config,
    headless: true,
    allowHooks: opts.allowHooks ?? false,
    sinks: buildNoopSinks(),
    modelCache: modelCacheStore,
    drainPendingAttachments: () => attachmentsStore.drain(),
    savedState,
    sessionId,
    _planner,
    _implementer,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onQuestionAsked: async () => '',
      onBudgetExceeded: async () => true,
      onBudgetPaused: async (currentCost, maxBudget) => {
        const pauseThreshold = config.workflow.budgetPauseThreshold ?? 0.85;
        process.stdout.write(
          JSON.stringify({ type: 'budget_paused', currentCost, maxBudget, threshold: pauseThreshold }) + '\n',
        );
        process.exit(1);
      },
      onContinuationNeeded: async () => '',
      onComplete: () => undefined,
    },
  });

  emitRecoveryAndFailIfPending(projectDir, sessionId);
}
