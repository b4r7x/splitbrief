import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { dirname } from 'node:path';
import { useTheme } from '../../../components/theme.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { Task } from '../../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import {
  buildTaskDetailParts,
  formatTaskReviewLine,
  getTaskStatusSymbol,
} from '../brief-review-format.js';
import { loadPlanEditorData } from '../plan-editor/loader.js';
import { BRIEFS_REVIEW_HINT } from '../review-parser.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { sanitizeTaskDisplayText } from './plan-editor/task-format.js';
import {
  getSimpleBriefMaxTaskOffset,
  getSimpleBriefTaskRowBudget,
  getSimpleBriefVisibleTaskCount,
} from '../layout/brief-review.js';
import { formatTaskIdentityParts } from '../layout/task-row.js';
import { PlanReviewHeader } from './brief-review-header.js';

const SIMPLE_REVIEW_OVERFLOW_HINT =
  'PageDown/PageUp inspect all | Ctrl+E/e rich edit | E/edit-file | comment <text> revises | reject';
const SIMPLE_REVIEW_COMPACT_HINT = 'approve | e rich | E file | comment | reject';
const SIMPLE_REVIEW_COMPACT_OVERFLOW_HINT = 'PgDn/PgUp | e rich | E file | comment | reject';

interface BriefReviewViewProps {
  filePath: string;
  height?: number;
  width?: number;
}

interface BriefData {
  tasks: Task[];
  quality: BriefQualityReport | null;
  loadError: string | null;
}

function useBriefData(filePath: string): BriefData {
  const [data, setData] = useState<BriefData>({
    tasks: [],
    quality: null,
    loadError: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load() {
      const { tasks, quality } = await loadPlanEditorData({
        filePath,
        sessionDirPath: dirname(filePath),
        signal,
        skipInitEditor: true,
      });
      if (signal.aborted) return;
      setData({ tasks, quality, loadError: null });
    }

    load().catch((err) => {
      if (!signal.aborted) {
        const message = toErrorMessage(err);
        setData({
          tasks: [],
          quality: null,
          loadError: `Failed to load Task Briefs: ${message}`,
        });
      }
    });
    return () => {
      controller.abort();
    };
  }, [filePath]);

  return data;
}

function fitBriefReviewText(text: string, width: number): string {
  return truncateTerminalDisplayText(text, Math.max(1, width));
}

function getBriefReviewHint(input: { hasOverflow: boolean; width: number }): string {
  const preferred = input.hasOverflow ? SIMPLE_REVIEW_OVERFLOW_HINT : BRIEFS_REVIEW_HINT;
  if (getTerminalCellWidth(preferred) <= input.width) return preferred;
  const compact = input.hasOverflow
    ? SIMPLE_REVIEW_COMPACT_OVERFLOW_HINT
    : SIMPLE_REVIEW_COMPACT_HINT;
  return fitBriefReviewText(compact, input.width);
}

function TaskRow({
  task,
  issues,
  width,
}: {
  task: Task;
  issues: BriefQualityIssue[];
  width: number;
}) {
  const t = useTheme();
  const reviewMetadata = planEditorStore.use((s) => s.reviewMetadata);
  const metadata = reviewMetadata.get(task.id);
  const hasError = issues.some((i) => i.severity === 'error');
  const hasWarning = issues.some((i) => i.severity === 'warning');
  const hasConflict = metadata?.conflict !== undefined;
  const hasOverflow = metadata?.contextFit === 'overflow';
  const hasStale = metadata?.stale ?? false;
  const hasValidationWarning =
    metadata?.validationStatus === 'fail' || metadata?.validationStatus === 'warn';
  const hasEstimateWarning =
    metadata?.estimateStatus === 'missing-current-code' ||
    metadata?.estimateStatus === 'current-code-unavailable';
  const statusSymbol = getTaskStatusSymbol(issues, metadata);
  const statusColor =
    hasConflict || hasOverflow || hasError
      ? t.error
      : hasWarning || hasStale || hasValidationWarning || hasEstimateWarning
        ? t.warning
        : t.success;

  const detailLine = sanitizeTaskDisplayText(buildTaskDetailParts(task));
  const reviewLine = sanitizeTaskDisplayText(formatTaskReviewLine(task, issues, metadata));
  const taskFile = sanitizeTaskDisplayText(task.file);
  const taskTitle = sanitizeTaskDisplayText(task.title);
  const identity = formatTaskIdentityParts({
    width,
    statusSymbol,
    taskId: task.id,
    status: task.status,
    file: taskFile,
    title: taskTitle,
  });

  const warningMsg = hasError
    ? sanitizeTaskDisplayText(
        issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.code.replace(/_/g, ' '))
          .join(', '),
      )
    : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width={width} overflow="hidden">
        <Text color={statusColor}>{identity.statusSymbol}</Text>
        <Text bold color={t.accent}>
          {identity.taskId}
        </Text>
        <Text> </Text>
        <Text color={t.textDim}>{identity.status}</Text>
        {identity.file !== '' && (
          <>
            <Text> </Text>
            <Text color={t.textDim}>{identity.file}</Text>
          </>
        )}
        <Text> </Text>
        <Text color={t.text} wrap="truncate">
          {identity.title}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={t.textDim} wrap="truncate">
          {detailLine}
        </Text>
        {warningMsg && (
          <Text color={t.error} wrap="truncate">
            {' '}
            {warningMsg}
          </Text>
        )}
      </Box>
      <Box paddingLeft={2}>
        <Text
          color={
            hasConflict || hasOverflow || hasStale || hasValidationWarning || hasEstimateWarning
              ? t.warning
              : t.textDim
          }
          wrap="truncate"
        >
          {reviewLine}
        </Text>
      </Box>
    </Box>
  );
}

function getVisibleBriefTaskWindow(
  tasks: Task[],
  rowBudget: number,
  scrollOffset: number,
): {
  visibleTasks: Task[];
  previousCount: number;
  nextCount: number;
  hasOverflow: boolean;
} {
  if (tasks.length === 0) {
    return {
      visibleTasks: [],
      previousCount: 0,
      nextCount: 0,
      hasOverflow: false,
    };
  }
  const visibleCount = getSimpleBriefVisibleTaskCount({
    rowBudget,
    taskCount: tasks.length,
  });
  if (visibleCount === 0) {
    return {
      visibleTasks: [],
      previousCount: 0,
      nextCount: tasks.length,
      hasOverflow: true,
    };
  }

  const maxStart = getSimpleBriefMaxTaskOffset({
    rowBudget,
    taskCount: tasks.length,
  });
  const start = Math.min(maxStart, Math.max(0, Math.floor(scrollOffset)));
  const end = Math.min(tasks.length, start + visibleCount);
  return {
    visibleTasks: tasks.slice(start, end),
    previousCount: start,
    nextCount: Math.max(0, tasks.length - end),
    hasOverflow: tasks.length > visibleCount,
  };
}

export function BriefReviewView({ filePath, height, width }: BriefReviewViewProps) {
  const t = useTheme();
  const { tasks, quality, loadError } = useBriefData(filePath);
  const reviewMetadata = planEditorStore.use((s) => s.reviewMetadata);
  const reviewScrollOffset = reviewStore.use((s) => s.scrollOffset);
  const containerHeight = height ?? 24;
  const rowWidth = Math.max(1, width ?? 80);
  const hasLoadError = loadError !== null;

  const taskRowBudget = getSimpleBriefTaskRowBudget({
    containerHeight,
    hasLoadError,
  });
  const { visibleTasks, previousCount, nextCount, hasOverflow } = getVisibleBriefTaskWindow(
    tasks,
    taskRowBudget,
    reviewScrollOffset,
  );

  useEffect(() => {
    reviewStore.setRenderedLineCount(tasks.length);
  }, [tasks.length]);

  const overflowNotice =
    previousCount > 0 || nextCount > 0
      ? [
          previousCount > 0 ? `${previousCount} earlier` : null,
          nextCount > 0 ? `${nextCount} more` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')
      : null;
  const reviewHint = getBriefReviewHint({ hasOverflow, width: rowWidth });
  const overflowHint =
    rowWidth < 72
      ? `${overflowNotice ?? ''} tasks (PgUp/PgDn, e)`
      : `${overflowNotice ?? ''} tasks (PageUp/PageDown, Ctrl+E/e)`;

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      <PlanReviewHeader
        tasks={tasks}
        quality={quality}
        reviewMetadata={reviewMetadata}
        filePath={filePath}
      />
      {loadError !== null && (
        <Text color={t.error} wrap="truncate">
          {loadError}
        </Text>
      )}
      <Box height={1} />
      <Box flexDirection="column" height={taskRowBudget} overflow="hidden">
        {visibleTasks.map((task) => {
          const issuesForTask = quality?.issues.filter((i) => i.taskId === task.id) ?? [];
          return <TaskRow key={task.id} task={task} issues={issuesForTask} width={rowWidth} />;
        })}
        {overflowNotice !== null && (
          <Text color={t.textDim}>{fitBriefReviewText(overflowHint, rowWidth)}</Text>
        )}
      </Box>
      <Box height={1} />
      <Text color={hasOverflow ? t.warning : t.textDim}>{reviewHint}</Text>
    </Box>
  );
}
