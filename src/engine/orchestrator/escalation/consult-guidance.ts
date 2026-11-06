import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { PLANNER_GUIDANCE_HEADING } from '../../spec/prompts/continuation.js';

/** The planner's guidance as the next attempt's instructions, its context attached. */
export function guidanceInstructions(instructions: string, context: string | null): string {
  const attached = context?.trim() ?? '';
  return attached === '' ? instructions : `${instructions}\n\n${attached}`;
}

/** The error block the one post-consult attempt retries with, under the planner's guidance. */
export function consultAttemptError(opts: { lastError: string; instructions: string }): string {
  const { lastError, instructions } = opts;
  return truncateByChars(
    `${lastError}\n\n${PLANNER_GUIDANCE_HEADING}\n${instructions}`,
    BOUNDS.consultFailingOutputChars,
  );
}

/**
 * The planner's guidance the current brief still carries: the last consult on its lineage named
 * this task and revision, answered with guidance, and no attempt of the brief failed after it.
 * A guided attempt stopped before it finished left no failure, so its guidance continues on the
 * attempt that takes the brief up again. An older record that named no attempt it followed
 * carries none, and a record on another brief of the lineage is not this brief's.
 */
export function unfinishedGuidance(state: WorkflowState, task: Task): string | undefined {
  const lineage = state.lineages?.[lineageIdOf(task)];
  const record = lineage?.consultRecords.at(-1);
  if (record === undefined) return undefined;
  if (record.taskId !== task.id) return undefined;
  if (record.revision !== (task.revision ?? 1)) return undefined;
  const answer = record.answer.answer;
  if (answer.action !== 'guidance') return undefined;
  const afterAttempt = record.afterAttempt;
  if (afterAttempt === undefined) return undefined;
  const ended = (lineage?.attemptFailures ?? []).some(
    (failure) => failure.taskId === task.id && failure.attempt > afterAttempt,
  );
  if (ended) return undefined;
  return guidanceInstructions(answer.instructions, answer.context);
}
