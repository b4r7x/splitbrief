export const SIMPLE_REVIEW_BASE_CHROME_ROWS = 7;
export const SIMPLE_TASK_ROW_HEIGHT = 3;

export function getSimpleBriefReviewChromeRows(input: { hasLoadError: boolean }): number {
  return SIMPLE_REVIEW_BASE_CHROME_ROWS + (input.hasLoadError ? 1 : 0);
}

export function getSimpleBriefTaskRowBudget(input: {
  containerHeight: number;
  hasLoadError: boolean;
}): number {
  return Math.max(
    0,
    input.containerHeight - getSimpleBriefReviewChromeRows({ hasLoadError: input.hasLoadError }),
  );
}

export function getSimpleBriefVisibleTaskCount(input: {
  rowBudget: number;
  taskCount: number;
}): number {
  if (input.taskCount <= 0 || input.rowBudget < SIMPLE_TASK_ROW_HEIGHT) return 0;

  const needsOverflowNotice = input.taskCount * SIMPLE_TASK_ROW_HEIGHT > input.rowBudget;
  const rowsForTasks =
    needsOverflowNotice && input.rowBudget > SIMPLE_TASK_ROW_HEIGHT
      ? input.rowBudget - 1
      : input.rowBudget;
  return Math.max(0, Math.floor(rowsForTasks / SIMPLE_TASK_ROW_HEIGHT));
}

export function getSimpleBriefMaxTaskOffset(input: {
  rowBudget: number;
  taskCount: number;
}): number {
  const visibleCount = getSimpleBriefVisibleTaskCount(input);
  return Math.max(0, input.taskCount - visibleCount);
}
