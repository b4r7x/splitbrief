import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { readFile } from 'node:fs/promises';
import { parseTasks } from '../../../engine/spec/parser.js';
import type { Task } from '../../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { dirname, join } from 'node:path';
import {
  buildTaskDetailParts,
  formatContextFit,
  formatPlanReviewSummary,
  formatQualityDisplay,
  formatTaskCount,
  formatTaskReviewLine,
  getTaskStatusSymbol,
  getReviewMetadataForTask,
  hasTaskReviewWarning,
  refreshPlanReviewMetadata,
} from './brief-review-view.js';
import { usePlanEditorKeys } from '../hooks/use-plan-editor-keys.js';
import { createSaveHandler } from '../hooks/use-plan-editor-save.js';
import type { PlanTaskReviewMetadata } from '../../../stores/workflow/plan-editor.js';

interface PlanEditorComponentProps {
  filePath: string;
  height?: number;
  width?: number;
  sessionDirPath?: string;
  onApprove?: () => void;
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  const t = useTheme();
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>{label}:</Text>
      {items.map((item, i) => (
        <Box key={`${label}-${i}`} flexDirection="row" paddingLeft={2}>
          <Text color={t.textDim}>- </Text>
          <Text color={t.text} wrap="truncate">{item}</Text>
        </Box>
      ))}
    </Box>
  );
}

function TaskEditorDetail({ task, metadata }: { task: Task; metadata?: PlanTaskReviewMetadata | undefined }) {
  const t = useTheme();
  const reviewItems = [
    `worker ${metadata?.workerProfile ?? 'auto'}`,
    `cost ${metadata?.selectedCostTier ?? 'pending'}`,
    `fit ${formatContextFit(metadata)}`,
    `validation ${metadata?.validationStatus ?? 'pending'}`,
    `risk ${metadata?.risk ?? 'pending'}`,
  ];
  const scopeItems = [
    ...(task.scope?.inBounds ?? []).map(item => `in ${item}`),
    ...(task.scope?.outOfBounds ?? []).map(item => `out ${item}`),
    ...(task.scope?.approvedOutOfBounds ?? []).map(item => `approved ${item}`),
  ];
  const routingItems = [
    metadata?.checkpoint ? `checkpoint ${metadata.checkpoint}` : null,
    metadata?.costPosture ? metadata.costPosture : null,
    metadata?.routingReason ? metadata.routingReason : null,
    metadata?.conflict ? `${metadata.conflict.kind}: ${metadata.conflict.files.join(', ')}` : null,
    metadata?.conflict?.note ? metadata.conflict.note : null,
    metadata?.stale ? 'stale input marker present' : null,
  ].filter((item): item is string => item !== null);

  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box flexDirection="row">
        <Text color={t.textDim}>scope: </Text>
        <Text color={t.text} wrap="truncate">{task.description}</Text>
      </Box>
      <DetailList label="review" items={reviewItems} />
      <DetailList label="scope bounds" items={scopeItems} />
      <DetailList label="steps" items={task.implementationSteps} />
      <DetailList label="constraints" items={task.constraints} />
      <DetailList label="tests" items={task.tests} />
      <DetailList label="escalation" items={task.escalation ?? []} />
      <DetailList label="routing" items={routingItems} />
    </Box>
  );
}

function getTaskEditorRowHeight(task: Task, isExpanded: boolean, metadata?: PlanTaskReviewMetadata | undefined): number {
  if (!isExpanded) return 3;
  const scopeItems = (task.scope?.inBounds?.length ?? 0)
    + (task.scope?.outOfBounds?.length ?? 0)
    + (task.scope?.approvedOutOfBounds?.length ?? 0);
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

interface VisibleTaskWindow {
  scrollOffset: number;
  visibleTasks: Task[];
}

function getVisibleTaskWindow(
  tasks: Task[],
  cursor: number,
  expandedIds: ReadonlySet<string>,
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>,
  rowBudget: number,
): VisibleTaskWindow {
  if (tasks.length === 0) return { scrollOffset: 0, visibleTasks: [] };

  const heightFor = (task: Task) => getTaskEditorRowHeight(task, expandedIds.has(task.id), metadata.get(task.id));
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

function TaskEditorRow({ task, isCursor, isExpanded, issues }: {
  task: Task;
  isCursor: boolean;
  isExpanded: boolean;
  issues: BriefQualityIssue[];
}) {
  const t = useTheme();
  const reviewMetadata = planEditorStore.use(s => s.reviewMetadata);
  const metadata = getReviewMetadataForTask(reviewMetadata, task);
  const hasConflict = metadata?.conflict !== undefined;
  const hasOverflow = metadata?.contextFit === 'overflow';
  const hasWarning = hasTaskReviewWarning(issues, metadata);
  const statusSymbol = getTaskStatusSymbol(issues, metadata);
  const statusColor = hasConflict || hasOverflow || metadata?.validationStatus === 'fail'
    ? t.error
    : hasWarning
      ? t.warning
      : t.success;
  const detailLine = buildTaskDetailParts(task);
  const reviewLine = formatTaskReviewLine(task, issues, metadata);
  const prefix = isCursor ? '> ' : '  ';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={isCursor ? t.accent : t.text}>{prefix}</Text>
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>{task.id}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.status}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.file}</Text>
        <Text>  </Text>
        <Text bold={isCursor} color={t.text}>{task.title}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={t.textDim} wrap="truncate">{detailLine}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={hasWarning ? t.warning : t.textDim} wrap="truncate">{reviewLine}</Text>
      </Box>
      {isExpanded && <TaskEditorDetail task={task} metadata={metadata} />}
    </Box>
  );
}

export function PlanEditorComponent({ filePath, height, width, sessionDirPath: sessionDirProp, onApprove }: PlanEditorComponentProps) {
  const t = useTheme();
  const sessionDirPath = sessionDirProp ?? dirname(filePath);
  const save = createSaveHandler(sessionDirPath, onApprove);
  usePlanEditorKeys(true, save, sessionDirPath);
  const [quality, setQuality] = useState<BriefQualityReport | null>(null);

  const tasks = planEditorStore.use(s => s.tasks);
  const cursor = planEditorStore.use(s => s.cursor);
  const expandedIds = planEditorStore.use(s => s.expandedIds);
  const dirty = planEditorStore.use(s => s.dirty);
  const saveError = planEditorStore.use(s => s.saveError);
  const reviewMetadata = planEditorStore.use(s => s.reviewMetadata);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load() {
      const [tasksText, qualityText] = await Promise.all([
        readFile(filePath, { encoding: 'utf8', signal }).catch(() => ''),
        readFile(join(dirname(filePath), 'brief-quality.json'), { encoding: 'utf8', signal }).catch(() => null),
      ]);
      if (signal.aborted) return;

      const parsed = parseTasks(tasksText);
      planEditorStore.initEditor(parsed);
      await refreshPlanReviewMetadata(parsed);
      if (signal.aborted) return;

      let q: BriefQualityReport | null = null;
      if (qualityText) {
        try {
          q = JSON.parse(qualityText) as BriefQualityReport;
        } catch {
          q = null;
        }
      }
      setQuality(q);
    }

    load().catch((err) => {
      if (!signal.aborted) {
        planEditorStore.setSaveError(`Failed to load Task Briefs: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return () => { controller.abort(); };
  }, [filePath]);

  const qualityDisplay = formatQualityDisplay(quality);
  const qualityColor = quality === null
    ? t.textDim
    : quality.passed
      ? t.success
      : t.error;

  const chromeRows = 7 + (dirty ? 1 : 0) + (saveError !== null ? 1 : 0);
  const taskRowBudget = Math.max(1, (height ?? 24) - chromeRows);
  const { scrollOffset, visibleTasks } = getVisibleTaskWindow(tasks, cursor, expandedIds, reviewMetadata, taskRowBudget);
  const isNarrow = (width ?? 80) < 70;

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      <Box flexDirection="row" gap={2}>
        <Text bold color={t.accent}>Task Briefs</Text>
        <Text color={t.textDim}>{formatTaskCount(tasks.length)}</Text>
        <Text color={qualityColor}>{qualityDisplay}</Text>
      </Box>
      <Text color={t.textDim}>{formatPlanReviewSummary(tasks, reviewMetadata)}</Text>
      <Text color={t.textDim}>{filePath}</Text>
      <Box height={1} />
      <Box flexDirection="column" height={taskRowBudget} overflow="hidden">
        {visibleTasks.map((task, i) => {
          const absoluteIndex = scrollOffset + i;
          const issuesForTask = quality?.issues.filter(issue => issue.taskId === task.id) ?? [];
          return (
            <TaskEditorRow
              key={task.id}
              task={task}
              isCursor={absoluteIndex === cursor}
              isExpanded={expandedIds.has(task.id)}
              issues={issuesForTask}
            />
          );
        })}
      </Box>
      {dirty && (
        <Text color={t.warning}>unsaved changes</Text>
      )}
      {saveError !== null && (
        <Text color={t.error}>{saveError}</Text>
      )}
      <Box height={1} />
      {isNarrow ? (
        <>
          <Text color={t.textDim}>j/k nav · d del · m merge · e edit</Text>
          <Text color={t.textDim}>{'s split · ^j/^k move · Y save · q quit · ?'}</Text>
        </>
      ) : (
        <>
          <Text color={t.textDim}>j/k navigate · d delete · m merge · e edit · s split</Text>
          <Text color={t.textDim}>{'<c-j>/<c-k> reorder · Y save · q discard · ? help'}</Text>
        </>
      )}
    </Box>
  );
}
