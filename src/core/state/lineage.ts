import type { ReportedDecision } from '../schemas/consult.js';
import { type TaskId, type Task, isTaskSettled, isTaskCompleted } from '../schemas/task.js';
import type { LineageRecord } from '../schemas/workflow/lineage.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import { taskDeclaredPatterns, isInDeclaredSet } from '../scope/declared-set.js';
import { lineageIdOf } from './task-insert.js';

/** The text a reported implementer decision contributes to the plan ledger. */
export function decisionLedgerText(decision: ReportedDecision): string {
  return decision.why === null ? decision.what : `${decision.what} — ${decision.why}`;
}

const EMPTY_LINEAGE: LineageRecord = {
  attempts: 0,
  dispatchedRevision: {},
  consultRecords: [],
  replacedParents: [],
};

export function lineageKeyFor(state: WorkflowState, taskId: TaskId): TaskId {
  const task = state.tasks.find((t) => t.id === taskId);
  return task === undefined ? taskId : lineageIdOf(task);
}

export function briefCorrections(state: WorkflowState, taskId: TaskId): readonly string[] {
  return state.lineages?.[lineageKeyFor(state, taskId)]?.corrections ?? [];
}

/** The attempts a task's lineage has spent; a lineage with no record starts fresh. */
export function lineageAttemptsOf(
  state: Pick<WorkflowState, 'lineages'>,
  task: Pick<Task, 'id' | 'parentId'>,
): number {
  return state.lineages?.[lineageIdOf(task)]?.attempts ?? 0;
}

export function withLineage(
  state: WorkflowState,
  key: TaskId,
  update: (lineage: LineageRecord) => LineageRecord,
): WorkflowState {
  const lineages = state.lineages ?? {};
  return {
    ...state,
    lineages: { ...lineages, [key]: update(lineages[key] ?? EMPTY_LINEAGE) },
  };
}

/** Whether a brief of the lineage `key`, other than `exceptId`, is still open. */
export function lineageHasOpenBrief(
  tasks: readonly Task[],
  key: TaskId,
  exceptId?: TaskId,
): boolean {
  return tasks.some((t) => lineageIdOf(t) === key && t.id !== exceptId && !isTaskSettled(t.status));
}

/**
 * The files of a lineage's `unbooked` changes that a brief books: the ones its declared set names
 * when it passes, or every one when it closes the lineage. A file two briefs name goes to the first
 * to pass, because it is booked from then on.
 */
export function lineageFilesToBook(
  brief: Task,
  closesLineage: boolean,
  unbooked: readonly string[],
): string[] {
  if (closesLineage) return [...unbooked];
  const declared = taskDeclaredPatterns(brief);
  return unbooked.filter((file) => isInDeclaredSet(file, declared));
}

/**
 * A rewrite or a split ends the brief's task-start snapshot, which records the writes of its
 * attempts. The lineage keeps it with the briefs done by then, which are the briefs done when the
 * replaced brief started, so a skip that closes the lineage can take those writes back.
 */
export function keepReplacedStart(state: WorkflowState, key: TaskId): WorkflowState {
  const snapshot = state.changedFilesBaseline?.activeTaskSnapshot;
  if (snapshot === undefined) return state;
  const doneAtStart = state.tasks
    .filter((task) => isTaskCompleted(task.status))
    .map((task) => task.id);
  return withLineage(state, key, (lineage) => ({
    ...lineage,
    replacedStarts: [...(lineage.replacedStarts ?? []), { snapshot, doneAtStart }],
  }));
}

/** A lineage keeps its task starts only while one of its briefs is still open. */
export function dropClosedLineageStart(state: WorkflowState, taskId: TaskId): WorkflowState {
  const key = lineageKeyFor(state, taskId);
  const lineage = state.lineages?.[key];
  if (lineage === undefined || lineageHasOpenBrief(state.tasks, key)) return state;
  const { startSnapshot: _closedStart, replacedStarts: _closedReplacedStarts, ...closed } = lineage;
  return { ...state, lineages: { ...state.lineages, [key]: closed } };
}
