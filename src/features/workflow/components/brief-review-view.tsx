import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { useTheme } from '../../../components/theme.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { parseTasks } from '../../../engine/spec/parser.js';
import type { Task } from '../../../core/schemas/task.js';
import { isBriefQualityReport, type BriefQualityIssue, type BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { planEditorStore, type PlanReviewCostTier, type PlanReviewEstimateStatus, type PlanReviewRisk, type PlanTaskReviewMetadata } from '../../../stores/workflow/plan-editor.js';
import { configStore } from '../../../stores/project/config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { routeTaskToImplementerProfile } from '../../../engine/orchestrator/context-routing/route.js';
import { buildProjectLanguageContext } from '../../../engine/spec/prompts/language-context.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { buildPlanReviewScorecard, type PlanReviewScorecardEntry } from '../plan-review-scorecard.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ProjectContext } from '../../../core/state/types.js';

const COST_TIER_ORDER: PlanReviewCostTier[] = ['local', 'cheap', 'standard', 'frontier', 'unknown'];
const SIMPLE_REVIEW_CHROME_ROWS = 7;
const SIMPLE_TASK_ROW_HEIGHT = 3;

export function formatQualityDisplay(quality: BriefQualityReport | null): string {
  if (quality === null) return 'quality n/a';
  return `quality ${quality.score.toFixed(2)}`;
}

export function hasTaskReviewWarning(
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): boolean {
  return issues.some(i => i.severity === 'error' || i.severity === 'warning')
    || metadata?.contextFit === 'overflow'
    || (metadata !== undefined && metadata.workerProfile === undefined)
    || metadata?.estimateStatus === 'missing-current-code'
    || metadata?.estimateStatus === 'current-code-unavailable'
    || metadata?.validationStatus === 'fail'
    || metadata?.validationStatus === 'warn'
    || metadata?.stale === true
    || metadata?.conflict !== undefined;
}

export function getTaskStatusSymbol(
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): '⚠' | '✓' {
  const hasBlockingReviewState = metadata?.contextFit === 'overflow'
    || (metadata !== undefined && metadata.workerProfile === undefined)
    || metadata?.estimateStatus === 'missing-current-code'
    || metadata?.estimateStatus === 'current-code-unavailable'
    || metadata?.validationStatus === 'fail'
    || metadata?.validationStatus === 'warn'
    || metadata?.stale === true
    || metadata?.conflict !== undefined;
  return issues.some(i => i.severity === 'error') || hasBlockingReviewState ? '⚠' : '✓';
}

export function buildTaskDetailParts(task: Task): string {
  const validationCount = task.tests.length;
  const evidenceCount = task.evidence?.length ?? 0;
  const hasScope = !!(task.scope?.inBounds?.length || task.scope?.outOfBounds?.length);
  const parts: string[] = [];
  if (validationCount > 0) parts.push(`validation: ${validationCount} check${validationCount === 1 ? '' : 's'}`);
  if (evidenceCount > 0) parts.push(`evidence: ${evidenceCount}`);
  parts.push(`scope: ${hasScope ? 'set' : 'missing'}`);
  return parts.join(' · ');
}

export function formatTaskCount(count: number): string {
  return `${count} task${count === 1 ? '' : 's'}`;
}

export function getReviewMetadataForTask(
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>,
  task: Task,
): PlanTaskReviewMetadata | undefined {
  return metadata.get(task.id);
}

function inferValidationStatus(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): NonNullable<PlanTaskReviewMetadata['validationStatus']> {
  if (metadata?.validationStatus) return metadata.validationStatus;
  if (issues.some(issue => issue.severity === 'error')) return 'fail';
  if (issues.some(issue => issue.severity === 'warning')) return 'warn';
  return task.tests.length > 0 ? 'pass' : 'pending';
}

function inferRisk(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): PlanReviewRisk {
  if (metadata?.risk) return metadata.risk;
  if (issues.some(issue => issue.severity === 'error')) return 'high';
  if (task.action === 'modify' || issues.some(issue => issue.severity === 'warning')) return 'medium';
  return 'low';
}

export function formatContextFit(metadata?: PlanTaskReviewMetadata | undefined): string {
  const fit = metadata?.contextFit ?? 'pending';
  const status = metadata?.estimateStatus;
  const statusText = status === 'missing-current-code' || status === 'current-code-unavailable'
    ? ` estimate ${status}`
    : '';
  if (metadata?.estimatedTokens === undefined) return `${fit}${statusText}`;
  if (metadata.contextLength === undefined) return `${fit} ${metadata.estimatedTokens}${statusText}`;
  return `${fit} ${metadata.estimatedTokens}/${metadata.contextLength}${statusText}`;
}

export function formatTaskReviewLine(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): string {
  const validationStatus = inferValidationStatus(task, issues, metadata);
  const risk = inferRisk(task, issues, metadata);
  const markers = [
    metadata?.conflict ? `conflict ${metadata.conflict.files.join(',')}` : null,
    metadata?.stale ? 'stale' : null,
    metadata?.checkpoint ? `checkpoint ${metadata.checkpoint}` : null,
  ].filter((part): part is string => part !== null);

  return [
    `worker ${metadata?.workerProfile ?? 'auto'}`,
    `cost ${metadata?.selectedCostTier ?? 'pending'}`,
    `fit ${formatContextFit(metadata)}`,
    `validation ${task.tests.length} ${validationStatus}`,
    `risk ${risk}`,
    ...markers,
  ].join(' · ');
}

export function formatPlanReviewSummary(
  tasks: Task[],
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>,
): string {
  const values = tasks.map(task => metadata.get(task.id)).filter((item): item is PlanTaskReviewMetadata => item !== undefined);
  const overflowCount = values.filter(item => item.contextFit === 'overflow').length;
  const tightCount = values.filter(item => item.contextFit === 'tight').length;
  const fitCount = values.filter(item => item.contextFit === 'fits').length;
  const tokenTotal = values.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
  const workers = Array.from(new Set(values.map(item => item.workerProfile).filter((worker): worker is string => !!worker))).sort();
  const costTierCounts = new Map<PlanReviewCostTier, number>();
  for (const item of values) {
    if (item.selectedCostTier === undefined) continue;
    costTierCounts.set(item.selectedCostTier, (costTierCounts.get(item.selectedCostTier) ?? 0) + 1);
  }

  const fitParts = [
    fitCount > 0 ? `${fitCount} fit` : null,
    tightCount > 0 ? `${tightCount} tight` : null,
    overflowCount > 0 ? `${overflowCount} overflow` : null,
  ].filter((part): part is string => part !== null);

  const context = fitParts.length > 0 ? fitParts.join(' · ') : 'fit pending';
  const costParts = COST_TIER_ORDER
    .map(tier => {
      const count = costTierCounts.get(tier) ?? 0;
      return count > 0 ? `${tier}:${count}` : null;
    })
    .filter((part): part is string => part !== null);
  const cost = costParts.length > 0 ? `cost ${costParts.join(',')}` : 'cost pending';
  const tokens = tokenTotal > 0 ? `tokens ${tokenTotal}` : 'tokens pending';
  const workerText = workers.length > 0 ? `workers ${workers.join(',')}` : 'workers auto';
  return `context ${context} · ${cost} · ${tokens} · ${workerText}`;
}

function getScorecardColor(entries: PlanReviewScorecardEntry[], theme: ReturnType<typeof useTheme>): string {
  if (entries.some(entry => entry.count > 0 && (entry.bucket === 'splitOverflow' || entry.bucket === 'staleConflict'))) return theme.error;
  if (entries.some(entry => entry.count > 0 && entry.bucket !== 'ready')) return theme.warning;
  if (entries.some(entry => entry.count > 0 && entry.bucket === 'ready')) return theme.success;
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
  const text = scorecard.buckets.map(entry => entry.label).join(' · ');

  return (
    <Text color={getScorecardColor(scorecard.buckets, t)} wrap="truncate">{text}</Text>
  );
}

export function buildRoutingPreviewMetadata(
  tasks: Task[],
  opts: { config: Config; projectDir: string },
): Promise<PlanTaskReviewMetadata[]> {
  const context: ProjectContext = {
    name: 'unknown',
    dir: opts.projectDir,
    runtime: 'node',
    testCommand: opts.config.validation.testCommand ?? 'npm test',
  };
  const profiles = resolveImplementerProfiles(opts.config).profiles;

  return Promise.all(tasks.map(async task => {
    const { task: routingTask, estimateStatus } = await refreshTaskForRoutingPreview(task, opts.projectDir);
    const decision = routeTaskToImplementerProfile({
      task: routingTask,
      context,
      profiles,
      languageContext: buildProjectLanguageContext(opts.projectDir, undefined),
    });
    const routeBlocked = decision.selectedProfile === undefined;
    const risk: PlanReviewRisk = routeBlocked || estimateStatus === 'missing-current-code' || estimateStatus === 'current-code-unavailable'
      ? 'high'
      : decision.fit === 'overflow'
      ? 'high'
      : routingTask.action === 'modify' || decision.fit === 'tight'
        ? 'medium'
        : 'low';
    const routingReason = routingPreviewReason(decision.reason, estimateStatus);

    return {
      taskId: routingTask.id,
      ...(decision.selectedProfile !== undefined && { workerProfile: decision.selectedProfile }),
      ...(decision.selectedCostTier !== undefined && { selectedCostTier: decision.selectedCostTier }),
      costPosture: decision.costPosture,
      contextFit: decision.fit,
      estimatedTokens: decision.estimatedTokens,
      ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
      ...(estimateStatus !== undefined && { estimateStatus }),
      routingReason,
      ...(routeBlocked || estimateStatus === 'missing-current-code' || estimateStatus === 'current-code-unavailable'
        ? { validationStatus: 'warn' as const }
        : {}),
      risk,
    };
  }));
}

export async function refreshTaskForRoutingPreview(
  task: Task,
  projectDir: string,
): Promise<{ task: Task; estimateStatus?: PlanReviewEstimateStatus | undefined }> {
  if (task.action !== 'modify') return { task };

  try {
    const currentCode = await readFile(join(projectDir, task.file), 'utf-8');
    return { task: { ...task, currentCode }, estimateStatus: 'refreshed-current-code' };
  } catch (err) {
    const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
    return {
      task: taskWithoutCurrentCode,
      estimateStatus: isENOENT(err) ? 'missing-current-code' : 'current-code-unavailable',
    };
  }
}

function routingPreviewReason(reason: string, estimateStatus?: PlanReviewEstimateStatus | undefined): string {
  if (estimateStatus === 'missing-current-code') {
    return `${reason}; review estimate is missing current code because the target file was not readable at review time`;
  }
  if (estimateStatus === 'current-code-unavailable') {
    return `${reason}; review estimate could not refresh current code`;
  }
  return reason;
}

export async function refreshPlanReviewMetadata(tasks: Task[]): Promise<PlanTaskReviewMetadata[] | null> {
  const { config, projectDir } = configStore.get();
  if (!config) return null;
  return buildRoutingPreviewMetadata(tasks, { config, projectDir });
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
      const [tasksText, qualityText] = await Promise.all([
        readFile(filePath, { encoding: 'utf8', signal }),
        readFile(join(dirname(filePath), 'brief-quality.json'), { encoding: 'utf8', signal }).catch(() => null),
      ]);
      if (signal.aborted) return;

      const tasks = parseTasks(tasksText);
      const metadata = await refreshPlanReviewMetadata(tasks);
      if (signal.aborted) return;
      if (metadata !== null) planEditorStore.setReviewMetadata(metadata);
      let quality: BriefQualityReport | null = null;
      if (qualityText) {
        try {
          const parsed = JSON.parse(qualityText) as unknown;
          quality = isBriefQualityReport(parsed) ? parsed : null;
        } catch {
          quality = null;
        }
      }
      setData({ tasks, quality, loadError: null });
    }

    load().catch((err) => {
      if (!signal.aborted) {
        const message = toErrorMessage(err);
        setData({ tasks: [], quality: null, loadError: `Failed to load Task Briefs: ${message}` });
      }
    });
    return () => { controller.abort(); };
  }, [filePath]);

  return data;
}

function TaskRow({ task, issues }: { task: Task; issues: BriefQualityIssue[] }) {
  const t = useTheme();
  const reviewMetadata = planEditorStore.use(s => s.reviewMetadata);
  const metadata = getReviewMetadataForTask(reviewMetadata, task);
  const hasError = issues.some(i => i.severity === 'error');
  const hasWarning = issues.some(i => i.severity === 'warning');
  const hasConflict = metadata?.conflict !== undefined;
  const hasOverflow = metadata?.contextFit === 'overflow';
  const hasStale = metadata?.stale === true;
  const hasValidationWarning = metadata?.validationStatus === 'fail' || metadata?.validationStatus === 'warn';
  const hasEstimateWarning = metadata?.estimateStatus === 'missing-current-code' || metadata?.estimateStatus === 'current-code-unavailable';
  const statusSymbol = getTaskStatusSymbol(issues, metadata);
  const statusColor = hasConflict || hasOverflow || hasError
    ? t.error
    : hasWarning || hasStale || hasValidationWarning || hasEstimateWarning
      ? t.warning
      : t.success;

  const detailLine = buildTaskDetailParts(task);
  const reviewLine = formatTaskReviewLine(task, issues, metadata);

  const warningMsg = hasError ? issues.filter(i => i.severity === 'error').map(i => i.code.replace(/_/g, ' ')).join(', ') : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>{task.id}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.status}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.file}</Text>
        <Text>        </Text>
        <Text color={t.text} wrap="truncate">{task.title}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={t.textDim} wrap="truncate">{detailLine}</Text>
        {warningMsg && <Text color={t.error} wrap="truncate">  {warningMsg}</Text>}
      </Box>
      <Box paddingLeft={2}>
        <Text color={hasConflict || hasOverflow || hasStale || hasValidationWarning || hasEstimateWarning ? t.warning : t.textDim} wrap="truncate">{reviewLine}</Text>
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
  const rowsForTasks = needsOverflowNotice && rowBudget > SIMPLE_TASK_ROW_HEIGHT
    ? rowBudget - 1
    : rowBudget;
  const visibleCount = Math.max(0, Math.floor(rowsForTasks / SIMPLE_TASK_ROW_HEIGHT));
  return {
    visibleTasks: tasks.slice(0, visibleCount),
    omittedCount: Math.max(0, tasks.length - visibleCount),
  };
}

export function BriefReviewView({ filePath, height, width }: BriefReviewViewProps) {
  const t = useTheme();
  const { tasks, quality, loadError } = useBriefData(filePath);
  const reviewMetadata = planEditorStore.use(s => s.reviewMetadata);

  const qualityDisplay = formatQualityDisplay(quality);

  const qualityColor = quality === null
    ? t.textDim
    : quality.passed
      ? t.success
      : t.error;
  const taskRowBudget = Math.max(0, (height ?? 24) - SIMPLE_REVIEW_CHROME_ROWS);
  const { visibleTasks, omittedCount } = getVisibleBriefTaskWindow(tasks, taskRowBudget);

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
      {loadError !== null && <Text color={t.error} wrap="truncate">{loadError}</Text>}
      <Box height={1} />
      <Box flexDirection="column" height={taskRowBudget} overflow="hidden">
        {visibleTasks.map(task => {
          const issuesForTask = quality?.issues.filter(i => i.taskId === task.id) ?? [];
          return <TaskRow key={task.id} task={task} issues={issuesForTask} />;
        })}
        {omittedCount > 0 && <Text color={t.textDim}>+ {omittedCount} more tasks</Text>}
      </Box>
      <Box height={1} />
      <Text color={t.textDim}>approve | e/edit | comment {'<text>'} | reject</Text>
    </Box>
  );
}
