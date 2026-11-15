import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { ConsultQuestion, ConsultReason } from '../../../core/schemas/consult.js';
import { nowIso } from '../../../utils/format/time.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { applyConsultAnswer } from '../consult/apply.js';
import { requestConsult } from '../consult/request.js';
import type { ConsultApplyOutcome } from '../consult/types.js';
import { haltAttempts } from '../recovery/builders/details.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/retry.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import { runConsultAttempt } from './attempt.js';
import { consultAttemptError, guidanceInstructions } from './consult-guidance.js';
import type { EscalationContext, LadderEnd, LadderState } from './types.js';
import { failedRetry } from './types.js';

/** The files this attempt changed since its snapshot; a diff the consult cannot render is empty. */
async function attemptChangedFiles(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  try {
    return await getChangedFilesSinceSnapshot(projectDir, snapshot);
  } catch {
    return [];
  }
}

/** Asks the consult seat about the last failure and applies its answer to the brief. */
async function consult(
  ctx: EscalationContext,
  ladder: LadderState,
  onConsult: (question: ConsultQuestion) => void,
): Promise<ConsultApplyOutcome> {
  const snapshot = ladder.attemptSnapshot;
  const changedFiles = await attemptChangedFiles(ctx.workspaceDir, snapshot);
  const reason: ConsultReason = ladder.blocked !== undefined ? 'blocked' : 'failed';
  onConsult({
    failingOutput: ladder.lastError,
    ...(ladder.blocked !== undefined && { report: ladder.blocked }),
    unfinishedCalls: ladder.unfinishedCalls,
  });
  const asked = await requestConsult(
    {
      projectDir: ctx.projectDir,
      workspaceDir: ctx.workspaceDir,
      sessionId: ctx.sessionId,
      bus: ctx.bus,
      config: ctx.config,
      planner: ctx.planner,
      state: ladder.state,
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      onStateChange: (next) => {
        ladder.state = next;
      },
    },
    {
      task: ladder.task,
      reason,
      failingOutput: ladder.lastError,
      report: ladder.blocked ?? null,
    },
  );
  if ('error' in asked) throw asked.error;

  return applyConsultAnswer(
    {
      projectDir: ctx.projectDir,
      workspaceDir: ctx.workspaceDir,
      sessionId: ctx.sessionId,
      bus: ctx.bus,
      config: ctx.config,
      validator: ctx.validator,
      callbacks: ctx.callbacks,
      sinks: ctx.sinks,
      state: ladder.state,
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      changedFiles,
      taskStartSnapshot: ctx.taskStartSnapshot,
      baseGate: ctx.baseGate,
      onStateChange: (next) => {
        ladder.state = next;
      },
    },
    ladder.task,
    asked.answer,
    snapshot,
  );
}

/**
 * Only the operator can answer the seat's question or overrule its "cannot", so asking the seat
 * again cannot help: the brief halts Needs you.
 */
function operatorHalt(
  ctx: EscalationContext,
  ladder: LadderState,
  applied: Extract<ConsultApplyOutcome, { action: 'unanswered' | 'cannot' }>,
): LadderEnd {
  const issue = buildRetryExhaustedRecoveryIssue({
    task: ladder.task,
    phase: ladder.state.phase,
    ...(applied.action === 'unanswered'
      ? { question: applied.question }
      : { cannot: applied.reason, cannotNext: applied.next }),
    validationSummary: ladder.lastError,
    ...haltAttempts(ladder.state, ladder.task, { booked: true }),
    allowRetryOverride: true,
    ...(ctx.implementerProfile !== undefined && {
      selectedImplementerProfile: ctx.implementerProfile,
    }),
    createdAt: nowIso(),
  });
  return {
    state: raisePendingRecovery(ctx, ladder.state, issue),
    result: failedRetry(ladder.attempts),
  };
}

/**
 * The consult loop of an escalating brief: a user's answer goes to the next attempt, and every
 * other red goes to the consult seat, whose answer ends the ladder or spends one more attempt.
 */
export async function runLadder(
  ctx: EscalationContext,
  ladder: LadderState,
  onConsult: (question: ConsultQuestion) => void,
): Promise<LadderEnd> {
  for (;;) {
    if (ctx.signal?.aborted) return { state: ladder.state, result: failedRetry(ladder.attempts) };

    // The user's answer is not a consult: the next attempt delivers it.
    if (ladder.answer !== undefined) {
      const halted = await runConsultAttempt(ctx, ladder, ladder.answer, true);
      if (halted) return halted;
      continue;
    }

    const applied = await consult(ctx, ladder, onConsult);

    // The consult replaced or split the brief; the task loop dispatches the new current task.
    if (applied.action === 'rewrite-task' || applied.action === 'split-task') {
      return {
        state: ladder.state,
        result: failedRetry(ladder.attempts, {
          lastError: ladder.lastError,
          ...(ladder.handBack !== undefined && { handBack: ladder.handBack }),
        }),
      };
    }
    if (applied.action === 'completed') {
      return {
        state: ladder.state,
        result: {
          completed: true,
          method: 'consulted',
          attempts: ladder.attempts,
          durationMs: applied.durationMs,
          ...(applied.bookedFiles.length > 0 && { changedFiles: applied.bookedFiles }),
        },
      };
    }
    if (applied.action === 'skipped') {
      return {
        state: ladder.state,
        result: { completed: false, method: 'skipped', attempts: ladder.attempts },
      };
    }
    if (applied.action === 'correction') {
      ladder.answer = applied.answer;
      continue;
    }
    if (applied.action === 'failed') {
      ladder.lastError = applied.reason;
      ladder.blocked = undefined;
      continue;
    }
    if (applied.action === 'unanswered' || applied.action === 'cannot') {
      return operatorHalt(ctx, ladder, applied);
    }

    const instructions = guidanceInstructions(applied.instructions, applied.context);
    const halted = await runConsultAttempt(
      ctx,
      ladder,
      consultAttemptError({ lastError: ladder.lastError, instructions }),
      false,
    );
    if (halted) return halted;
  }
}
