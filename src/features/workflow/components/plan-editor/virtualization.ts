import type { Task } from '../../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import type {
  PlanEditorFocus,
  PlanEditorSectionEdit,
} from '../../../../stores/workflow/plan-editor.js';
import { TASK_BRIEF_SECTIONS } from '../../../../stores/workflow/plan-editor-sections.js';
import { clampIndex } from '../../../../utils/indexing.js';

const COLLAPSED_TASK_ROW_HEIGHT = 3;
const EXPANDED_SCOPE_ROW_HEIGHT = 1;
const REVIEW_DETAIL_ITEM_COUNT = 5;
const MAX_EDITING_INPUT_ROWS = 6;

export interface VisibleTaskWindow {
  scrollOffset: number;
  visibleTasks: Task[];
}

export interface TaskEditorRowHeightOptions {
  isCursor?: boolean | undefined;
  focus?: PlanEditorFocus | undefined;
  editing?: PlanEditorSectionEdit | null | undefined;
}

export function getTaskEditorRowHeight(
  task: Task,
  isExpanded: boolean,
  metadata?: PlanTaskReviewMetadata | undefined,
  options: TaskEditorRowHeightOptions = {},
): number {
  if (!isExpanded) return COLLAPSED_TASK_ROW_HEIGHT;
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
  const detailRows =
    EXPANDED_SCOPE_ROW_HEIGHT +
    [
      REVIEW_DETAIL_ITEM_COUNT,
      scopeItems,
      task.implementationSteps.length,
      task.constraints.length,
      task.tests.length,
      task.evidence?.length ?? 0,
      task.escalation?.length ?? 0,
      routingItems,
    ].reduce((sum, count) => sum + getDetailListRowCount(count), 0);
  return COLLAPSED_TASK_ROW_HEIGHT + detailRows + getSectionControlRows(task, options);
}

function getDetailListRowCount(itemCount: number): number {
  return itemCount > 0 ? itemCount + 1 : 0;
}

function getSectionControlRows(task: Task, options: TaskEditorRowHeightOptions): number {
  if (!options.isCursor || options.focus === undefined || options.focus === 'task-list') return 0;

  const listRows = 1 + TASK_BRIEF_SECTIONS.length;
  if (options.focus !== 'editing-section' || options.editing?.taskId !== task.id) {
    return listRows;
  }

  return listRows + getEditingInputRows(options.editing.value);
}

export function getEditingInputRows(value: string): number {
  return Math.min(MAX_EDITING_INPUT_ROWS, Math.max(1, value.split(/\r?\n/).length));
}

export interface VisibleTaskWindowInput {
  tasks: Task[];
  cursor: number;
  expandedIds: ReadonlySet<string>;
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  rowBudget: number;
  focus?: PlanEditorFocus | undefined;
  editing?: PlanEditorSectionEdit | null | undefined;
}

export function getVisibleTaskWindow(input: VisibleTaskWindowInput): VisibleTaskWindow {
  const { tasks, cursor, expandedIds, metadata, rowBudget, focus, editing } = input;
  if (tasks.length === 0 || rowBudget <= 0) return { scrollOffset: 0, visibleTasks: [] };

  const clampedCursor = clampIndex(cursor, tasks.length);
  const heightFor = (task: Task, index: number) =>
    getTaskEditorRowHeight(task, expandedIds.has(task.id), metadata.get(task.id), {
      isCursor: index === clampedCursor,
      focus,
      editing,
    });
  const cursorTask = tasks[clampedCursor];
  if (!cursorTask) return { scrollOffset: 0, visibleTasks: [] };
  let start = clampedCursor;
  let usedRows = heightFor(cursorTask, clampedCursor);

  let previousTask = tasks[start - 1];
  while (previousTask && usedRows + heightFor(previousTask, start - 1) <= rowBudget) {
    start -= 1;
    usedRows += heightFor(previousTask, start);
    previousTask = tasks[start - 1];
  }

  let end = clampedCursor + 1;
  let nextTask = tasks[end];
  while (nextTask && usedRows + heightFor(nextTask, end) <= rowBudget) {
    usedRows += heightFor(nextTask, end);
    end += 1;
    nextTask = tasks[end];
  }

  return { scrollOffset: start, visibleTasks: tasks.slice(start, end) };
}
