import type { Task } from '../../../core/schemas/task.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { defaultImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import type { GateAndPromoteOutcome } from '../approval/gate-and-promote.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import {
  createBusTextHandler,
  publishError,
  publishEscalate,
  publishPlannerStatus,
} from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { runRetryStep } from './step.js';
import {
  MAX_HINT_ERROR_LENGTH,
  failedRetry,
  type EscalationContext,
  type RetryStepOutcome,
  type TierStepInput,
} from './types.js';

export async function runHintTier(input: TierStepInput): Promise<RetryStepOutcome> {
  const { ctx, task: initialTask, lastError, priorAttempts } = input;
  let state = input.state;
  const attempts = priorAttempts + 1;
  const reviewerHandler = createBusTextHandler(
    { bus: ctx.bus, phase: state.phase },
    { role: 'planner', content: 'markdown' },
  );
  const retryHandler = createBusTextHandler(
    { bus: ctx.bus, phase: state.phase },
    { role: 'implementer' },
  );
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
  const workspace = await ctx.isolation.acquire({
    role: 'planner',
    config: ctx.config,
    writesFiles:
      ctx.implementer.capabilities?.writesFiles ??
      defaultImplementerWriteMode(ctx.config.implementer.kind),
  });
  let tier1Result: Awaited<ReturnType<typeof ctx.planner.escalateHint>>;
  try {
    tier1Result = await ctx.planner.escalateHint({
      task: initialTask,
      error: lastError,
      projectDir: workspace.projectDir,
      callbacks: {
        onOutput: reviewerHandler,
        signal: ctx.signal,
      },
      languageContext,
      fileIgnoreProjectDir: ctx.projectDir,
      sandboxEnv: workspace.sandboxEnv,
      changeDetection: workspace.changeDetection,
    });
  } catch (err) {
    workspace.cleanup();
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
    getApprovalEnabled: ctx.getApprovalEnabled,
    workspace,
    usesIsolation: true,
    taskStartSnapshot: ctx.taskStartSnapshot,
    dependsOnFiles: ctx.dependsOnFiles,
    catchChangedFilesError: true,
    signal: ctx.signal,
    cleanup: workspace.cleanup,
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
    reviewerHandler(tier1Result.output);
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
    invokeRetry: makeImplementerRetryInvoker({
      context: ctx.context,
      kind: 'hint',
      languageContext,
      phase: state.phase,
      onOutput: retryHandler,
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
    publishError({
      bus: ctx.bus,
      phase: gateResult.state.phase,
      message: `Hint-tier changed files blocked by approval gate: ${reason} (${files})`,
    });
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
  publishError({ bus: ctx.bus, phase: gateResult.state.phase, message: reason });
  return {
    state: gateResult.state,
    task,
    lastError: reason,
    attempts,
    result: failedRetry(attempts),
  };
}
