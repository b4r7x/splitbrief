import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import type { Theme } from '../ui/theme.js';

interface TaskSummaryProps {
  index: number;
  title: string;
  method: 'local' | 'escalated' | 'failed' | 'skipped';
  retries?: number;
  duration?: number;
  reason?: string;
}

export function renderTaskSummary({ index, title, method, retries, duration, reason }: TaskSummaryProps, t: Theme) {
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

  const meta: string[] = [method];
  if (retries && retries > 0) meta.push(`${retries} ${retries === 1 ? 'retry' : 'retries'}`);
  if (duration != null) meta.push(`${duration}s`);

  return (
    <Box>
      <Text color={t.success}>✓ </Text>
      <Text color={t.text}>T{index} {title}</Text>
      <Text color={t.textDim}> — {meta.join(', ')}</Text>
    </Box>
  );
}

export default function TaskSummary(props: TaskSummaryProps) {
  const t = useTheme();
  return renderTaskSummary(props, t);
}
