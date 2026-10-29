import { error } from '../../utils/error.js';
import type { ConsultAnswer } from '../schemas/consult.js';
import type { TriageResult } from '../schemas/review.js';
import type { Task, TaskId } from '../schemas/task.js';
import type { ConsultRecord, WorkflowState } from '../schemas/workflow.js';
import { lineageIdOf } from '../state/task-insert.js';

/** The fix task a stuck review of the cycle asks the planner about: the cycle's last one. */
export function stuckTarget(state: WorkflowState, cycle: number): Task | undefined {
  return state.tasks.findLast((task) => task.fix?.cycle === cycle);
}

/** The planner's answer to the stuck review of the fix cycle; one stuck cycle gets one consult. */
export function stuckConsult(state: WorkflowState, cycle: number): ConsultRecord | undefined {
  const target = stuckTarget(state, cycle);
  if (target === undefined) return undefined;
  return state.lineages?.[lineageIdOf(target)]?.consultRecords.findLast(
    (record) => record.reason === 'no-progress' && record.taskId === target.id,
  );
}

/**
 * The next fix cycle the planner's answer gives a stuck review. Guidance goes with each of the
 * reviewer's fix briefs; a rewrite or a split replaces them and carries every finding they held.
 * An ask-user answer asks the user on the review question path. The reviewer's rejections and
 * re-runs stay.
 */
export function plannerFixWork(
  reviewer: TriageResult,
  answer: ConsultAnswer['answer'],
): TriageResult {
  const findingIds = [...new Set(reviewer.fixTasks.flatMap((task) => task.findingIds))];
  switch (answer.action) {
    case 'guidance': {
      const note = [
        `Planner guidance: ${answer.instructions}`,
        ...(answer.context === null ? [] : [`Context: ${answer.context}`]),
      ].join('\n');
      return {
        ...reviewer,
        fixTasks: reviewer.fixTasks.map((task) => ({
          ...task,
          intent: `${task.intent}\n\n${note}`,
        })),
      };
    }
    case 'rewrite-task':
      return { ...reviewer, fixTasks: [{ ...answer.task, findingIds }] };
    case 'split-task':
      return { ...reviewer, fixTasks: answer.tasks.map((task) => ({ ...task, findingIds })) };
    case 'ask-user':
      return {
        ...reviewer,
        fixTasks: [],
        ask: { question: answer.question, whyOnlyUserCanAnswer: answer.whyOnlyUserCanAnswer },
      };
    case 'verify':
      throw error('stuck-review-verify', 'A stuck review takes no verify answer.');
  }
}

/** What the planner's answer to a stuck review gives the next cycle, for the row and `--plain`. */
export function stuckAnswerWords(action: string, newTaskIds: readonly TaskId[] | null): string {
  if (action === 'ask-user') return 'asks you';
  const ids = (newTaskIds ?? []).join(', ');
  if (action === 'guidance') return ids === '' ? 'guidance' : `guidance for ${ids}`;
  return newTaskIds?.length === 1 ? `new fix brief ${ids}` : `new fix briefs ${ids}`;
}
