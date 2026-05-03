import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { configStore } from '../../../stores/project/config.js';
import { readFile } from 'node:fs/promises';
import { parseTasks } from '../../../engine/spec/parser.js';
import type { Task } from '../../../core/schemas/task.js';
import { isBriefQualityReport, type BriefQualityIssue, type BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import type { ProjectContext } from '../../../core/state/types.js';
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
  PlanReviewScorecardLine,
  refreshPlanReviewMetadata,
  refreshTaskForRoutingPreview,
} from './brief-review-view.js';
import { usePlanEditorKeys } from '../hooks/use-plan-editor-keys.js';
import { createSaveHandler } from '../hooks/use-plan-editor-save.js';
import type { PlanReviewEstimateStatus, PlanTaskReviewMetadata } from '../../../stores/workflow/plan-editor.js';
import { buildWorkerPacketPreview, type WorkerPacketPreview } from '../worker-packet-preview.js';
import type { RoutingDecision } from '../../../engine/orchestrator/context-routing.js';
import { routeTaskToImplementerProfile } from '../../../engine/orchestrator/context-routing.js';
import { buildProjectLanguageContext } from '../../../engine/spec/prompts/language-context.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { PlanEditorFooter } from './plan-editor-footer.js';

interface PlanEditorComponentProps {
  filePath: string;
  height?: number;
  width?: number;
  sessionDirPath?: string;
  onApprove?: () => void;
  onRegenerateFlagged?: () => Promise<void>;
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

function compactValue(value: string | number | undefined): string {
  return value === undefined || value === '' ? 'pending' : String(value);
}

function compactExcerpt(text: string): string {
  return text.split('\n').map(line => line.trim()).filter(Boolean).join(' / ');
}

function taskWithoutCurrentCode(task: Task): Task {
  const { currentCode: _currentCode, ...withoutCurrentCode } = task;
  return withoutCurrentCode;
}

interface PacketPreviewRefresh {
  sourceTask: Task;
  projectDir: string;
  task: Task;
  estimateStatus?: PlanReviewEstimateStatus | undefined;
  routingDecision?: RoutingDecision | undefined;
}

function buildPreviewNoticeLine(preview: WorkerPacketPreview): string {
  const notices = [
    preview.redacted ? 'redacted' : null,
    preview.truncated ? 'truncated' : null,
    preview.routingPending ? 'routing pending' : null,
    preview.refreshRequired ? 'refresh required' : null,
  ].filter((notice): notice is string => notice !== null);
  return notices.length > 0 ? notices.join(' · ') : 'ready';
}

function WorkerPacketPreviewPanel({
  preview,
  rows,
}: {
  preview: WorkerPacketPreview | null;
  rows: number;
}) {
  const t = useTheme();
  if (!preview || rows <= 0) return null;
  if (rows < 7) {
    return (
      <Text color={t.textDim} wrap="truncate">
        packet preview collapsed; resize for selected-task packet
      </Text>
    );
  }

  const writeMode = preview.selectedWriteMode ?? preview.requiredWriteMode;
  const systemExcerpt = compactExcerpt(preview.visibleSystemPreamble);
  const promptExcerpt = compactExcerpt(preview.visibleTaskPrompt);

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Text bold color={t.accent}>Packet Preview {preview.taskId}</Text>
      <Text color={t.textDim} wrap="truncate">
        worker {compactValue(preview.workerProfile)} · cost {compactValue(preview.costTier)} · write {compactValue(writeMode)}
      </Text>
      <Text color={t.textDim} wrap="truncate">
        fit {compactValue(preview.contextFit)} · tokens {compactValue(preview.estimatedTokens)} · context {compactValue(preview.contextLength)}
      </Text>
      <Text color={preview.refreshRequired ? t.warning : t.textDim} wrap="truncate">
        current-code {preview.currentCodeContextMode} · estimate {compactValue(preview.estimateStatus)}{preview.stale ? ' · stale' : ''}{preview.refreshRequired ? ' · refresh required' : ''}
      </Text>
      <Text color={preview.routingPending || preview.refreshRequired ? t.warning : t.textDim} wrap="truncate">
        notice {buildPreviewNoticeLine(preview)}
      </Text>
      <Text color={t.textDim} wrap="truncate">system {systemExcerpt}</Text>
      <Text color={t.textDim} wrap="truncate">task {promptExcerpt}</Text>
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

function TaskEditorRow({ task, isCursor, isExpanded, isFlagged, issues }: {
  task: Task;
  isCursor: boolean;
  isExpanded: boolean;
  isFlagged: boolean;
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
        {isFlagged && <Text color={t.error}>✗ </Text>}
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

export function PlanEditorComponent({ filePath, height, width, sessionDirPath: sessionDirProp, onApprove, onRegenerateFlagged }: PlanEditorComponentProps) {
  const t = useTheme();
  const sessionDirPath = sessionDirProp ?? dirname(filePath);
  const [loadError, setLoadError] = useState<string | null>(null);
  const rawSave = createSaveHandler(sessionDirPath, onApprove);
  const save = async () => {
    if (loadError !== null) {
      planEditorStore.setSaveError(loadError);
      return;
    }
    await rawSave();
  };
  const [isPacketPreviewOpen, setIsPacketPreviewOpen] = useState(false);
  usePlanEditorKeys(true, save, sessionDirPath, () => setIsPacketPreviewOpen(open => !open), onRegenerateFlagged);
  const [quality, setQuality] = useState<BriefQualityReport | null>(null);
  const [packetPreviewRefresh, setPacketPreviewRefresh] = useState<PacketPreviewRefresh | null>(null);

  const tasks = planEditorStore.use(s => s.tasks);
  const cursor = planEditorStore.use(s => s.cursor);
  const expandedIds = planEditorStore.use(s => s.expandedIds);
  const flaggedIds = planEditorStore.use(s => s.flaggedIds);
  const dirty = planEditorStore.use(s => s.dirty);
  const saveError = planEditorStore.use(s => s.saveError);
  const reviewMetadata = planEditorStore.use(s => s.reviewMetadata);
  const configState = configStore.use(s => s);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load() {
      const [tasksText, qualityText] = await Promise.all([
        readFile(filePath, { encoding: 'utf8', signal }),
        readFile(join(dirname(filePath), 'brief-quality.json'), { encoding: 'utf8', signal }).catch(() => null),
      ]);
      if (signal.aborted) return;

      const parsed = parseTasks(tasksText);
      planEditorStore.initEditor(parsed);
      const metadata = await refreshPlanReviewMetadata(parsed);
      if (signal.aborted) return;
      if (metadata !== null) planEditorStore.setReviewMetadata(metadata);
      setLoadError(null);

      let q: BriefQualityReport | null = null;
      if (qualityText) {
        try {
          const parsedQuality = JSON.parse(qualityText) as unknown;
          q = isBriefQualityReport(parsedQuality) ? parsedQuality : null;
        } catch {
          q = null;
        }
      }
      setQuality(q);
    }

    load().catch((err) => {
      if (!signal.aborted) {
        const message = `Failed to load Task Briefs: ${err instanceof Error ? err.message : String(err)}`;
        setLoadError(message);
        planEditorStore.setSaveError(message);
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

  const selectedTask = tasks[cursor];
  const projectDir = configState.projectDir || sessionDirPath;
  const testCommand = configState.config?.validation.testCommand ?? 'npm test';

  useEffect(() => {
    if (!isPacketPreviewOpen || !selectedTask) {
      setPacketPreviewRefresh(null);
      return;
    }

    const previewSourceTask = selectedTask;

    if (previewSourceTask.action !== 'modify') {
      setPacketPreviewRefresh({
        sourceTask: previewSourceTask,
        projectDir,
        task: previewSourceTask,
      });
      return;
    }

    const controller = new AbortController();
    setPacketPreviewRefresh({
      sourceTask: previewSourceTask,
      projectDir,
      task: taskWithoutCurrentCode(previewSourceTask),
    });

    async function refreshPacketPreviewTask() {
      const { task, estimateStatus } = await refreshTaskForRoutingPreview(previewSourceTask, projectDir);
      if (controller.signal.aborted) return;

      let routingDecision: RoutingDecision | undefined;
      if (configState.config) {
        const profiles = resolveImplementerProfiles(configState.config).profiles;
        const context: ProjectContext = {
          name: 'unknown',
          dir: projectDir,
          runtime: 'node',
          testCommand,
        };
        routingDecision = routeTaskToImplementerProfile({
          task,
          context,
          profiles,
          languageContext: buildProjectLanguageContext(projectDir, undefined),
        });
      }

      if (controller.signal.aborted) return;
      setPacketPreviewRefresh({
        sourceTask: previewSourceTask,
        projectDir,
        task,
        estimateStatus,
        ...(routingDecision !== undefined ? { routingDecision } : {}),
      });
    }

    refreshPacketPreviewTask().catch(() => {
      if (controller.signal.aborted) return;
      setPacketPreviewRefresh({
        sourceTask: previewSourceTask,
        projectDir,
        task: taskWithoutCurrentCode(previewSourceTask),
        estimateStatus: 'current-code-unavailable',
      });
    });

    return () => { controller.abort(); };
  }, [isPacketPreviewOpen, selectedTask, projectDir, configState.config, testCommand]);

  const previewRows = isPacketPreviewOpen
    ? (height ?? 24) < 18
      ? 1
      : Math.min(8, Math.max(7, Math.floor((height ?? 24) / 3)))
    : 0;
  const chromeRows = 8 + previewRows + (dirty ? 1 : 0) + (saveError !== null ? 1 : 0);
  const taskRowBudget = Math.max(1, (height ?? 24) - chromeRows);
  const { scrollOffset, visibleTasks } = getVisibleTaskWindow(tasks, cursor, expandedIds, reviewMetadata, taskRowBudget);
  const isNarrow = (width ?? 80) < 70;
  const projectContext: ProjectContext = {
    name: 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand,
  };
  const selectedTaskMetadata = selectedTask ? getReviewMetadataForTask(reviewMetadata, selectedTask) : undefined;
  const hasPreviewRefresh = packetPreviewRefresh !== null
    && packetPreviewRefresh.sourceTask === selectedTask
    && packetPreviewRefresh.projectDir === projectDir;
  const previewTask = selectedTask?.action === 'modify'
    ? hasPreviewRefresh
      ? packetPreviewRefresh.task
      : taskWithoutCurrentCode(selectedTask)
    : selectedTask;
  const previewMetadata = hasPreviewRefresh && packetPreviewRefresh.estimateStatus !== undefined
    ? { ...selectedTaskMetadata, taskId: packetPreviewRefresh.task.id, estimateStatus: packetPreviewRefresh.estimateStatus }
    : selectedTaskMetadata;
  const packetPreview = isPacketPreviewOpen
    ? buildWorkerPacketPreview({
      task: previewTask,
      context: projectContext,
      ...(previewMetadata !== undefined ? { metadata: previewMetadata } : {}),
      ...(hasPreviewRefresh && packetPreviewRefresh.routingDecision !== undefined ? { routingDecision: packetPreviewRefresh.routingDecision } : {}),
      ...(previewMetadata?.contextLength !== undefined ? { contextLength: previewMetadata.contextLength } : {}),
      display: {
        maxSystemChars: Math.max(80, (width ?? 80) * 2),
        maxPromptChars: Math.max(120, (width ?? 80) * 3),
        maxSystemLines: 2,
      },
    })
    : null;
  const isCollapsedPacketPreview = isPacketPreviewOpen && previewRows <= 1;

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      <Box flexDirection="row" gap={2}>
        <Text bold color={t.accent}>Task Briefs</Text>
        <Text color={t.textDim}>{formatTaskCount(tasks.length)}</Text>
        <Text color={qualityColor}>{qualityDisplay}</Text>
      </Box>
      <Text color={t.textDim}>{formatPlanReviewSummary(tasks, reviewMetadata)}</Text>
      <PlanReviewScorecardLine tasks={tasks} quality={quality} metadata={reviewMetadata} />
      <Text color={t.textDim}>{filePath}</Text>
      {isCollapsedPacketPreview
        ? <WorkerPacketPreviewPanel preview={packetPreview} rows={previewRows} />
        : <Box height={1} />}
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
              isFlagged={flaggedIds.has(task.id)}
              issues={issuesForTask}
            />
          );
        })}
      </Box>
      {!isCollapsedPacketPreview && <WorkerPacketPreviewPanel preview={packetPreview} rows={previewRows} />}
      {dirty && (
        <Text color={t.warning}>unsaved changes</Text>
      )}
      {saveError !== null && (
        <Text color={t.error} wrap="truncate">{saveError}</Text>
      )}
      <Box height={1} />
      <PlanEditorFooter isPacketPreviewOpen={isPacketPreviewOpen} isNarrow={isNarrow} />
    </Box>
  );
}
