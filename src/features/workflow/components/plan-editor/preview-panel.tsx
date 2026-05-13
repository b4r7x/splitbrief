import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { ProjectContext } from '../../../../core/state/types.js';
import { resolveImplementerProfiles } from '../../../../core/config/accessors/implementer-profiles.js';
import { routeTaskToImplementerProfile } from '../../../../engine/orchestrator/context-routing/route.js';
import type { RoutingDecision } from '../../../../engine/orchestrator/context-routing/types.js';
import { buildProjectLanguageContext } from '../../../../engine/spec/prompts/language-context.js';
import type { PlanReviewEstimateStatus, PlanTaskReviewMetadata } from '../../../../stores/workflow/plan-editor.js';
import { buildWorkerPacketPreview, type WorkerPacketPreview } from '../../worker-packet-preview.js';
import { refreshTaskForRoutingPreview } from '../brief-review.js';
import { compactExcerpt, compactValue, taskWithoutCurrentCode } from './task-helpers.js';

interface PacketPreviewRefresh {
  sourceTask: Task;
  projectDir: string;
  task: Task;
  estimateStatus?: PlanReviewEstimateStatus | undefined;
  routingDecision?: RoutingDecision | undefined;
}

interface UsePacketPreviewOptions {
  isOpen: boolean;
  selectedTask?: Task | undefined;
  selectedTaskMetadata?: PlanTaskReviewMetadata | undefined;
  projectDir: string;
  testCommand: string;
  config: Config | null;
  width?: number | undefined;
}

function buildProjectContext(projectDir: string, testCommand: string): ProjectContext {
  return {
    name: 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand,
  };
}

export function usePacketPreview(opts: UsePacketPreviewOptions): WorkerPacketPreview | null {
  const {
    isOpen,
    selectedTask,
    selectedTaskMetadata,
    projectDir,
    testCommand,
    config,
    width,
  } = opts;
  const [packetPreviewRefresh, setPacketPreviewRefresh] = useState<PacketPreviewRefresh | null>(null);

  useEffect(() => {
    if (!isOpen || !selectedTask) {
      setPacketPreviewRefresh(null);
      return;
    }
    if (selectedTask.action !== 'modify') {
      setPacketPreviewRefresh(null);
      return;
    }

    const previewSourceTask = selectedTask;
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
      if (config) {
        const profiles = resolveImplementerProfiles(config).profiles;
        routingDecision = routeTaskToImplementerProfile({
          task,
          context: buildProjectContext(projectDir, testCommand),
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
  }, [isOpen, selectedTask, projectDir, config, testCommand]);

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

  return isOpen
    ? buildWorkerPacketPreview({
      task: previewTask,
      context: buildProjectContext(projectDir, testCommand),
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

export function WorkerPacketPreviewPanel({
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
