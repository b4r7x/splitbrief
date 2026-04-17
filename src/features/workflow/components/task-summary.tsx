import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { TaskCompletionMethod } from '../../../core/types/summary.js';
import { getMethodDisplay } from '../../../core/sessions-display.js';

interface TaskSummaryProps {
  index: number;
  title: string;
  method: TaskCompletionMethod;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  reason?: string | undefined;
}

export function TaskSummary({ index, title, method, retries, duration, file, reason }: TaskSummaryProps) {
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

  const label = getMethodDisplay(method, t).text;
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
