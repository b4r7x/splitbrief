import type { WorkflowOpts } from '../core/types/config-options.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { loadConfig } from '../core/config/load/load.js';
import { applyCLIOverrides } from '../core/config/runtime/overrides.js';
import { warnStderr } from '../lib/warn.js';
import { runWorkflow } from '../engine/orchestrator/run/run.js';
import { cliError } from './errors.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

export async function runHeadless(
  feature: string,
  projectDir: string,
  opts: WorkflowOpts,
  savedState?: WorkflowState | undefined,
  sessionId?: string | undefined,
): Promise<void> {
  const { config: loaded, warnings } = loadConfig(projectDir);
  for (const w of warnings) warnStderr(`⚠ ${w}`);

  const config = applyCLIOverrides(loaded, {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
    },
    autoApprove: opts.auto !== undefined ? opts.auto : true,
    mode: opts.mode,
    budget: opts.budget,
  });

  if (!config) throw cliError('Failed to load config');

  await runWorkflow({
    feature,
    projectDir,
    config,
    headless: true,
    sinks: buildNoopSinks(),
    savedState,
    sessionId,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onExternalChanges: async () => true,
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
}
