import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { useTheme } from '../../../components/theme.js';
import { parseTasks } from '../../../engine/spec/parser.js';
import type { Task } from '../../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';

export function formatQualityDisplay(quality: BriefQualityReport | null): string {
  if (quality === null) return 'quality n/a';
  return `quality ${quality.score.toFixed(2)}`;
}

export function getTaskStatusSymbol(issues: BriefQualityIssue[]): '⚠' | '✓' {
  return issues.some(i => i.severity === 'error') ? '⚠' : '✓';
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

interface BriefReviewViewProps {
  filePath: string;
  height?: number;
  width?: number;
}

interface BriefData {
  tasks: Task[];
  quality: BriefQualityReport | null;
}

function useBriefData(filePath: string): BriefData {
  const [data, setData] = useState<BriefData>({ tasks: [], quality: null });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load() {
      const [tasksText, qualityText] = await Promise.all([
        readFile(filePath, { encoding: 'utf8', signal }).catch(() => ''),
        readFile(join(dirname(filePath), 'brief-quality.json'), { encoding: 'utf8', signal }).catch(() => null),
      ]);
      if (signal.aborted) return;

      const tasks = parseTasks(tasksText);
      let quality: BriefQualityReport | null = null;
      if (qualityText) {
        try {
          quality = JSON.parse(qualityText) as BriefQualityReport;
        } catch {
          quality = null;
        }
      }
      setData({ tasks, quality });
    }

    load().catch(() => {
      if (!signal.aborted) setData({ tasks: [], quality: null });
    });
    return () => { controller.abort(); };
  }, [filePath]);

  return data;
}

function TaskRow({ task, issues }: { task: Task; issues: BriefQualityIssue[] }) {
  const t = useTheme();
  const hasError = issues.some(i => i.severity === 'error');
  const hasWarning = issues.some(i => i.severity === 'warning');
  const statusSymbol = getTaskStatusSymbol(issues);
  const statusColor = hasError ? t.error : hasWarning ? t.warning : t.success;

  const detailLine = buildTaskDetailParts(task);

  const warningMsg = hasError ? issues.filter(i => i.severity === 'error').map(i => i.code.replace(/_/g, ' ')).join(', ') : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>{task.id}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.file}</Text>
        <Text>        </Text>
        <Text color={t.text}>{task.title}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={t.textDim}>{detailLine}</Text>
        {warningMsg && <Text color={t.error}>  {warningMsg}</Text>}
      </Box>
    </Box>
  );
}

export function BriefReviewView({ filePath, height, width }: BriefReviewViewProps) {
  const t = useTheme();
  const { tasks, quality } = useBriefData(filePath);

  const qualityDisplay = formatQualityDisplay(quality);

  const qualityColor = quality === null
    ? t.textDim
    : quality.passed
      ? t.success
      : t.error;

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
        {tasks.map(task => {
          const issuesForTask = quality?.issues.filter(i => i.taskId === task.id) ?? [];
          return <TaskRow key={task.id} task={task} issues={issuesForTask} />;
        })}
      </Box>
      <Box height={1} />
      <Text color={t.textDim}>approve | e/edit | comment {'<text>'} | reject</Text>
    </Box>
  );
}
