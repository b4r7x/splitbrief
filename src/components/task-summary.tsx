import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import type { TaskCompletionMethod } from '../types.js';

const METHOD_LABELS: Partial<Record<TaskCompletionMethod, string>> = {
  'escalated-hint': 'hint',
  'escalated-full': 'escalated',
};

interface TaskSummaryProps {
  index: number;
  title: string;
  method: TaskCompletionMethod;
  retries?: number;
  duration?: number;
  file?: string;
  reason?: string;
}

export default function TaskSummary({ index, title, method, retries, duration, file, reason }: TaskSummaryProps) {
  const t = useTheme();

  if (method === 'failed') {
    return (
      <Box>
        <Text color={t.error}>✗ </Text>
        <Text color={t.error}>T{index} {title}</Text>
        <Text color={t.textDim}> — failed</Text>
      </Box>
    );
  }

  if (method === 'skipped') {
    return (
      <Box>
        <Text color={t.textDim}>⊘ T{index} {title} — skipped{reason ? `: ${reason}` : ''}</Text>
      </Box>
    );
  }

  const label = METHOD_LABELS[method] ?? method;
  const meta: string[] = [label];
  if (retries && retries > 0) meta.push(`${retries} ${retries === 1 ? 'retry' : 'retries'}`);
  if (duration != null) meta.push(`${duration}s`);

  return (
    <Box>
      <Text color={t.success}>✓ </Text>
      <Text color={t.text}>T{index} {title}</Text>
      {file && <Text color={t.textDim}>  {file}</Text>}
      <Text color={t.textDim}>  {meta.join(' ')}</Text>
    </Box>
  );
}
