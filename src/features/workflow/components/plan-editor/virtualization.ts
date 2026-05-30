import type { Task } from '../../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../../stores/workflow/plan-editor.js';

export interface VisibleTaskWindow {
  scrollOffset: number;
  visibleTasks: Task[];
}

export function getTaskEditorRowHeight(
  task: Task,
  isExpanded: boolean,
  metadata?: PlanTaskReviewMetadata | undefined,
): number {
  if (!isExpanded) return 3;
  const scopeItems =
    (task.scope?.inBounds?.length ?? 0) +
    (task.scope?.outOfBounds?.length ?? 0) +
    (task.scope?.approvedOutOfBounds?.length ?? 0);
  const routingItems = [
    metadata?.checkpoint,
    metadata?.costPosture,
    metadata?.routingReason,
    metadata?.conflict,
    metadata?.conflict?.note,
    metadata?.stale,
  ].filter(Boolean).length;
  const detailListRows = [
    4,
    scopeItems,
    task.implementationSteps.length,
    task.constraints.length,
    task.tests.length,
    task.escalation?.length ?? 0,
    routingItems,
  ].reduce((sum, count) => sum + (count > 0 ? count + 1 : 0), 0);
  return 3 + 1 + detailListRows;
}

export interface VisibleTaskWindowInput {
  tasks: Task[];
  cursor: number;
  expandedIds: ReadonlySet<string>;
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  rowBudget: number;
}

export function getVisibleTaskWindow(input: VisibleTaskWindowInput): VisibleTaskWindow {
  const { tasks, cursor, expandedIds, metadata, rowBudget } = input;
  if (tasks.length === 0) return { scrollOffset: 0, visibleTasks: [] };

  const heightFor = (task: Task) =>
    getTaskEditorRowHeight(task, expandedIds.has(task.id), metadata.get(task.id));
  const clampedCursor = Math.max(0, Math.min(cursor, tasks.length - 1));
  const cursorTask = tasks[clampedCursor];
  if (!cursorTask) return { scrollOffset: 0, visibleTasks: [] };
  let start = clampedCursor;
  let usedRows = heightFor(cursorTask);

  let previousTask = tasks[start - 1];
  while (previousTask && usedRows + heightFor(previousTask) <= rowBudget) {
    start -= 1;
    usedRows += heightFor(previousTask);
    previousTask = tasks[start - 1];
  }

  let end = clampedCursor + 1;
  let nextTask = tasks[end];
  while (nextTask && usedRows + heightFor(nextTask) <= rowBudget) {
    usedRows += heightFor(nextTask);
    end += 1;
    nextTask = tasks[end];
  }

  return { scrollOffset: start, visibleTasks: tasks.slice(start, end) };
}
