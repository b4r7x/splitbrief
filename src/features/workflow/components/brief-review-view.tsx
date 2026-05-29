import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { dirname } from 'node:path';
import { useTheme } from '../../../components/theme.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { Task } from '../../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import {
  planEditorStore,
  type PlanTaskReviewMetadata,
} from '../../../stores/workflow/plan-editor.js';
import {
  buildPlanReviewScorecard,
  type PlanReviewScorecardEntry,
} from '../plan-review-scorecard.js';
import {
  buildTaskDetailParts,
  formatPlanReviewSummary,
  formatQualityDisplay,
  formatTaskCount,
  formatTaskReviewLine,
  getTaskStatusSymbol,
} from './brief-review-format.js';
import { loadPlanEditorData } from './plan-editor/loader.js';

const SIMPLE_REVIEW_CHROME_ROWS = 7;
const SIMPLE_TASK_ROW_HEIGHT = 3;

function getScorecardColor(
  entries: PlanReviewScorecardEntry[],
  theme: ReturnType<typeof useTheme>,
): string {
  if (
    entries.some(
      (entry) =>
        entry.count > 0 && (entry.bucket === 'splitOverflow' || entry.bucket === 'staleConflict'),
    )
  )
    return theme.error;
  if (entries.some((entry) => entry.count > 0 && entry.bucket !== 'ready')) return theme.warning;
  if (entries.some((entry) => entry.count > 0 && entry.bucket === 'ready')) return theme.success;
  return theme.textDim;
}

export function PlanReviewScorecardLine({
  tasks,
  quality,
  metadata,
}: {
  tasks: Task[];
  quality: BriefQualityReport | null;
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
}) {
  const t = useTheme();
  const scorecard = buildPlanReviewScorecard(tasks, quality, metadata);
  const text = scorecard.buckets.map((entry) => entry.label).join(' · ');

  return (
    <Text color={getScorecardColor(scorecard.buckets, t)} wrap="truncate">
      {text}
    </Text>
  );
}

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
  const [data, setData] = useState<BriefData>({ tasks: [], quality: null, loadError: null });

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
        setData({ tasks: [], quality: null, loadError: `Failed to load Task Briefs: ${message}` });
      }
    });
    return () => {
      controller.abort();
    };
  }, [filePath]);

  return data;
}

function TaskRow({ task, issues }: { task: Task; issues: BriefQualityIssue[] }) {
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

  const detailLine = buildTaskDetailParts(task);
  const reviewLine = formatTaskReviewLine(task, issues, metadata);

  const warningMsg = hasError
    ? issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.code.replace(/_/g, ' '))
        .join(', ')
    : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>
          {task.id}
        </Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.status}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.file}</Text>
        <Text> </Text>
        <Text color={t.text} wrap="truncate">
          {task.title}
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
): { visibleTasks: Task[]; omittedCount: number } {
  if (tasks.length === 0) return { visibleTasks: [], omittedCount: 0 };
  if (rowBudget < SIMPLE_TASK_ROW_HEIGHT) {
    return { visibleTasks: [], omittedCount: tasks.length };
  }

  const needsOverflowNotice = tasks.length * SIMPLE_TASK_ROW_HEIGHT > rowBudget;
  const rowsForTasks =
    needsOverflowNotice && rowBudget > SIMPLE_TASK_ROW_HEIGHT ? rowBudget - 1 : rowBudget;
  const visibleCount = Math.max(0, Math.floor(rowsForTasks / SIMPLE_TASK_ROW_HEIGHT));
  return {
    visibleTasks: tasks.slice(0, visibleCount),
    omittedCount: Math.max(0, tasks.length - visibleCount),
  };
}

export function BriefReviewView({ filePath, height, width }: BriefReviewViewProps) {
  const t = useTheme();
  const { tasks, quality, loadError } = useBriefData(filePath);
  const reviewMetadata = planEditorStore.use((s) => s.reviewMetadata);

  const qualityDisplay = formatQualityDisplay(quality);

  const qualityColor = quality === null ? t.textDim : quality.passed ? t.success : t.error;
  const taskRowBudget = Math.max(0, (height ?? 24) - SIMPLE_REVIEW_CHROME_ROWS);
  const { visibleTasks, omittedCount } = getVisibleBriefTaskWindow(tasks, taskRowBudget);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      <Box flexDirection="row" gap={2}>
        <Text bold color={t.accent}>
          Task Briefs
        </Text>
        <Text color={t.textDim}>{formatTaskCount(tasks.length)}</Text>
        <Text color={qualityColor}>{qualityDisplay}</Text>
      </Box>
      <Text color={t.textDim}>{formatPlanReviewSummary(tasks, reviewMetadata)}</Text>
      <PlanReviewScorecardLine tasks={tasks} quality={quality} metadata={reviewMetadata} />
      <Text color={t.textDim}>{filePath}</Text>
      {loadError !== null && (
        <Text color={t.error} wrap="truncate">
          {loadError}
        </Text>
      )}
      <Box height={1} />
      <Box flexDirection="column" height={taskRowBudget} overflow="hidden">
        {visibleTasks.map((task) => {
          const issuesForTask = quality?.issues.filter((i) => i.taskId === task.id) ?? [];
          return <TaskRow key={task.id} task={task} issues={issuesForTask} />;
        })}
        {omittedCount > 0 && <Text color={t.textDim}>+ {omittedCount} more tasks</Text>}
      </Box>
      <Box height={1} />
      <Text color={t.textDim}>approve | e/edit | comment {'<text>'} | reject</Text>
    </Box>
  );
}
