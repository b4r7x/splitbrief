import type { ConsultAnswer } from '../schemas/consult.js';
import type { TriageResult } from '../schemas/review.js';
import type { Task, TaskId } from '../schemas/task.js';
import type { ConsultRecord, WorkflowState } from '../schemas/workflow.js';
import { lineageIdOf } from '../state/task-insert.js';
import { oneLineDisplayText } from '../../utils/display-text.js';

/** The task a stuck review asks the planner on: the judged fix cycle's last brief, else the last brief that ran. */
export function stuckTarget(state: WorkflowState, cycle: number | undefined): Task | undefined {
  return (
    state.tasks.findLast((task) => cycle !== undefined && task.fix?.cycle === cycle) ??
    state.tasks.findLast((task) => task.status !== 'pending')
  );
}

/** The planner's answer to the stuck review recorded at `reviewAt`; one review round gets one consult. */
export function stuckConsult(
  state: WorkflowState,
  target: Task,
  reviewAt: string,
): ConsultRecord | undefined {
  return state.lineages?.[lineageIdOf(target)]?.consultRecords.findLast(
    (record) =>
      record.reason === 'no-progress' && record.taskId === target.id && record.at >= reviewAt,
  );
}

/** A stuck review's answer that shapes the next fix cycle; `accept` and `cannot` end the round. */
export type StuckFixAnswer = Exclude<ConsultAnswer['answer'], { action: 'accept' | 'cannot' }>;

/**
 * The next fix cycle the planner's answer gives a stuck review. Guidance goes with each of the
 * reviewer's fix briefs; a rewrite or a split replaces them and carries every finding they held,
 * or the blockers when the reviewer wrote none. A verify runs no fix brief: SPLITBRIEF re-runs its
 * checks before the next review. An ask-user answer asks the user on the review question path.
 * The reviewer's rejections and re-runs stay.
 */
export function plannerFixWork(
  reviewer: TriageResult,
  answer: StuckFixAnswer,
  blockerIds: readonly string[],
): TriageResult {
  const reviewerIds = [...new Set(reviewer.fixTasks.flatMap((task) => task.findingIds))];
  const findingIds = reviewerIds.length > 0 ? reviewerIds : [...blockerIds];
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
    case 'verify':
      return { ...reviewer, fixTasks: [] };
    case 'ask-user':
      return {
        ...reviewer,
        fixTasks: [],
        ask: { question: answer.question, whyOnlyUserCanAnswer: answer.whyOnlyUserCanAnswer },
      };
  }
}

/**
 * Why the contract refuses a planner's answer to a stuck review: guidance with no reviewer fix
 * brief to carry it, a re-run of no check or of a check the run does not know, or an accept while
 * a red check or an Apply conflict blocks, which the user's Accept as is refuses too.
 */
export function stuckAnswerErrors(
  answer: ConsultAnswer['answer'],
  stuck: Readonly<{
    fixWork: TriageResult;
    redInputs: readonly string[];
    knownChecks: ReadonlySet<string>;
  }>,
): string[] {
  switch (answer.action) {
    case 'guidance':
      return stuck.fixWork.fixTasks.length === 0
        ? ['guidance needs a reviewer fix brief to carry it; this review wrote none']
        : [];
    case 'verify': {
      if (answer.checkIds.length === 0) return ['verify names no check to re-run'];
      const unknown = answer.checkIds.filter((id) => !stuck.knownChecks.has(id));
      return unknown.length === 0 ? [] : [`verify names unknown checks: ${unknown.join(', ')}`];
    }
    case 'accept':
      return stuck.redInputs.length === 0
        ? []
        : [
            `accept cannot take ${stuck.redInputs.join(', ')} while ${stuck.redInputs.length === 1 ? 'it blocks' : 'they block'}: verify a red check or fix it`,
          ];
    default:
      return [];
  }
}

/** What the planner's answer to a stuck review does next, for the row and `--plain`. */
export function stuckAnswerWords(
  answer: Readonly<{
    action: string;
    newTaskIds: readonly TaskId[] | null;
    checkIds?: readonly string[] | undefined;
    note?: string | undefined;
  }>,
): string {
  const ids = (answer.newTaskIds ?? []).join(', ');
  switch (answer.action) {
    case 'ask-user':
      return 'asks you';
    case 'cannot':
      return 'says it cannot be done';
    case 'verify':
      return `re-runs ${(answer.checkIds ?? []).join(', ')}`;
    case 'accept':
      return answer.note === undefined
        ? 'accepts the blockers'
        : `accepts the blockers: ${oneLineDisplayText(answer.note)}`;
    case 'guidance':
      return ids === '' ? 'guidance' : `guidance for ${ids}`;
    default:
      return answer.newTaskIds?.length === 1 ? `new fix brief ${ids}` : `new fix briefs ${ids}`;
  }
}
