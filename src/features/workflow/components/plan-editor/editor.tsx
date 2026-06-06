import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { dirname } from 'node:path';
import { useTheme } from '../../../../components/theme.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { configStore } from '../../../../stores/project/config.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';
import type { BriefQualityReport } from '../../../../engine/spec/brief-quality.js';
import { PlanReviewHeader } from '../brief-review-view.js';
import { usePlanEditorKeys } from '../../hooks/use-plan-editor-keys.js';
import { createSaveHandler } from '../../plan-editor-save.js';
import { PlanEditorFooter } from './footer.js';
import { loadPlanEditorData } from './loader.js';
import { WorkerPacketPreviewPanel, usePacketPreview } from './preview-panel.js';
import { TaskEditorRow } from './task-row.js';
import { getVisibleTaskWindow } from './virtualization.js';

interface PlanEditorComponentProps {
  filePath: string;
  height?: number;
  width?: number;
  sessionDirPath?: string;
  onApprove?: () => void;
  onRegenerateFlagged?: () => Promise<void>;
}

export function PlanEditorComponent({
  filePath,
  height,
  width,
  sessionDirPath: sessionDirProp,
  onApprove,
  onRegenerateFlagged,
}: PlanEditorComponentProps) {
  const t = useTheme();
  const sessionDirPath = sessionDirProp ?? dirname(filePath);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quality, setQuality] = useState<BriefQualityReport | null>(null);
  const [isPacketPreviewOpen, setIsPacketPreviewOpen] = useState(false);
  const rawSave = createSaveHandler(sessionDirPath, onApprove);
  const save = async () => {
    if (loadError !== null) {
      planEditorStore.setSaveError(loadError);
      return;
    }
    await rawSave();
  };

  usePlanEditorKeys({
    onSave: save,
    sessionDir: sessionDirPath,
    onTogglePacketPreview: () => setIsPacketPreviewOpen((open) => !open),
    onRegenerateFlagged,
  });

  const tasks = planEditorStore.use((s) => s.tasks);
  const cursor = planEditorStore.use((s) => s.cursor);
  const expandedIds = planEditorStore.use((s) => s.expandedIds);
  const flaggedIds = planEditorStore.use((s) => s.flaggedIds);
  const dirty = planEditorStore.use((s) => s.dirty);
  const saveError = planEditorStore.use((s) => s.saveError);
  const reviewMetadata = planEditorStore.use((s) => s.reviewMetadata);
  const configState = configStore.use((s) => s);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    loadPlanEditorData({ filePath, sessionDirPath, signal })
      .then(({ quality: loadedQuality }) => {
        if (signal.aborted) return;
        setLoadError(null);
        setQuality(loadedQuality);
      })
      .catch((err) => {
        if (!signal.aborted) {
          const message = `Failed to load Task Briefs: ${toErrorMessage(err)}`;
          setLoadError(message);
          planEditorStore.setSaveError(message);
        }
      });

    return () => {
      controller.abort();
    };
  }, [filePath, sessionDirPath]);

  const selectedTask = tasks[cursor];
  const selectedTaskMetadata = selectedTask ? reviewMetadata.get(selectedTask.id) : undefined;
  const projectDir = configState.projectDir || sessionDirPath;
  const testCommand = configState.config?.validation.testCommand ?? 'npm test';
  const previewRows = isPacketPreviewOpen
    ? (height ?? 24) < 18
      ? 1
      : Math.min(8, Math.max(7, Math.floor((height ?? 24) / 3)))
    : 0;
  const chromeRows = 8 + previewRows + (dirty ? 1 : 0) + (saveError !== null ? 1 : 0);
  const taskRowBudget = Math.max(1, (height ?? 24) - chromeRows);
  const { scrollOffset, visibleTasks } = getVisibleTaskWindow({
    tasks,
    cursor,
    expandedIds,
    metadata: reviewMetadata,
    rowBudget: taskRowBudget,
  });
  const isNarrow = (width ?? 80) < 70;
  const packetPreview = usePacketPreview({
    isOpen: isPacketPreviewOpen,
    selectedTask,
    selectedTaskMetadata,
    projectDir,
    testCommand,
    config: configState.config,
    width,
  });
  const isCollapsedPacketPreview = isPacketPreviewOpen && previewRows <= 1;

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      <PlanReviewHeader
        tasks={tasks}
        quality={quality}
        reviewMetadata={reviewMetadata}
        filePath={filePath}
      />
      {isCollapsedPacketPreview ? (
        <WorkerPacketPreviewPanel preview={packetPreview} rows={previewRows} />
      ) : (
        <Box height={1} />
      )}
      <Box flexDirection="column" height={taskRowBudget} overflow="hidden">
        {visibleTasks.map((task, i) => {
          const absoluteIndex = scrollOffset + i;
          const issuesForTask = quality?.issues.filter((issue) => issue.taskId === task.id) ?? [];
          return (
            <TaskEditorRow
              key={task.id}
              task={task}
              metadata={reviewMetadata.get(task.id)}
              isCursor={absoluteIndex === cursor}
              isExpanded={expandedIds.has(task.id)}
              isFlagged={flaggedIds.has(task.id)}
              issues={issuesForTask}
            />
          );
        })}
      </Box>
      {!isCollapsedPacketPreview && (
        <WorkerPacketPreviewPanel preview={packetPreview} rows={previewRows} />
      )}
      {dirty && <Text color={t.warning}>unsaved changes</Text>}
      {saveError !== null && (
        <Text color={t.error} wrap="truncate">
          {saveError}
        </Text>
      )}
      <Box height={1} />
      <PlanEditorFooter isPacketPreviewOpen={isPacketPreviewOpen} isNarrow={isNarrow} />
    </Box>
  );
}
