import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { readFile } from 'node:fs/promises';
import { parseTasks } from '../../../engine/spec/parser.js';
import type { Task } from '../../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { dirname, join } from 'node:path';
import { buildTaskDetailParts, formatQualityDisplay, formatTaskCount } from './brief-review-view.js';
import { usePlanEditorKeys } from '../hooks/use-plan-editor-keys.js';
import { createSaveHandler } from '../hooks/use-plan-editor-save.js';

interface PlanEditorComponentProps {
  filePath: string;
  height?: number;
  width?: number;
  sessionDirPath?: string;
  onApprove?: () => void;
}

function TaskEditorDetail({ task }: { task: Task }) {
  const t = useTheme();
  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box flexDirection="row">
        <Text color={t.textDim}>desc: </Text>
        <Text color={t.text}>{task.description}</Text>
      </Box>
      {task.implementationSteps.length > 0 && (
        <Box flexDirection="column">
          <Text color={t.textDim}>steps:</Text>
          {task.implementationSteps.map((step, i) => (
            <Box key={i} flexDirection="row" paddingLeft={2}>
              <Text color={t.textDim}>{i + 1}. </Text>
              <Text color={t.text}>{step}</Text>
            </Box>
          ))}
        </Box>
      )}
      {task.tests.length > 0 && (
        <Box flexDirection="column">
          <Text color={t.textDim}>tests:</Text>
          {task.tests.map((test, i) => (
            <Box key={i} flexDirection="row" paddingLeft={2}>
              <Text color={t.textDim}>• </Text>
              <Text color={t.text}>{test}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function TaskEditorRow({ task, isCursor, isExpanded, issues }: {
  task: Task;
  isCursor: boolean;
  isExpanded: boolean;
  issues: BriefQualityIssue[];
}) {
  const t = useTheme();
  const hasError = issues.some(i => i.severity === 'error');
  const statusSymbol: '⚠' | '✓' = hasError ? '⚠' : '✓';
  const statusColor = hasError ? t.error : t.success;
  const detailLine = buildTaskDetailParts(task);
  const prefix = isCursor ? '> ' : '  ';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={isCursor ? t.accent : t.text}>{prefix}</Text>
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>{task.id}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.file}</Text>
        <Text>  </Text>
        <Text bold={isCursor} color={t.text}>{task.title}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={t.textDim}>{detailLine}</Text>
      </Box>
      {isExpanded && <TaskEditorDetail task={task} />}
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

  // Reserve rows for: header (1), file path (1), spacer (1), dirty indicator (1), save error (1), footer (2) = 7
  const reservedRows = 7;
  const visibleRows = Math.max(1, (height ?? 24) - reservedRows);

  const scrollOffset = tasks.length === 0
    ? 0
    : Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), tasks.length - visibleRows));

  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      <Box flexDirection="row" gap={2}>
        <Text bold color={t.accent}>Task Briefs</Text>
        <Text color={t.textDim}>{formatTaskCount(tasks.length)}</Text>
        <Text color={qualityColor}>{qualityDisplay}</Text>
      </Box>
      <Text color={t.textDim}>{filePath}</Text>
      <Box height={1} />
      <Box flexDirection="column">
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
      <Text color={t.textDim}>j/k navigate · d delete · m merge · e edit</Text>
      <Text color={t.textDim}>{'<c-j>/<c-k> reorder · Y save · q discard · ? help'}</Text>
    </Box>
  );
}
