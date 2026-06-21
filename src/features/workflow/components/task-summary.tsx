import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { getMethodDisplay } from '../../../core/sessions/display.js';
import { STATUS_GLYPH } from '../../../components/task-status-glyph.js';
import { formatDuration } from '../../../utils/format-time.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';

interface TaskSummaryProps {
  index: number;
  title: string;
  method: TaskCompletionMethod;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  reason?: string | undefined;
}

export function TaskSummary({
  index,
  title,
  method,
  retries,
  duration,
  file,
  reason,
}: TaskSummaryProps) {
  const t = useTheme();
  const safeTitle = sanitizeTerminalDisplayText(title);
  const safeFile = file === undefined ? undefined : sanitizeTerminalDisplayText(file);
  const safeReason = reason === undefined ? undefined : sanitizeTerminalDisplayText(reason);

  if (method === 'failed') {
    return (
      <Box>
        <Text color={t.error}>{STATUS_GLYPH.failed} </Text>
        <Text color={t.error}>
          T{index} {safeTitle}
        </Text>
        <Text color={t.textDim}> — failed</Text>
      </Box>
    );
  }

  if (method === 'skipped') {
    return (
      <Box>
        <Text color={t.textDim}>
          {STATUS_GLYPH.skipped} T{index} {safeTitle} — skipped
          {safeReason ? `: ${safeReason}` : ''}
        </Text>
      </Box>
    );
  }

  const label = getMethodDisplay(method, t).text;
  const meta: string[] = [label];
  if (retries && retries > 0) meta.push(`${retries} ${retries === 1 ? 'retry' : 'retries'}`);
  if (duration != null) meta.push(formatDuration(duration));

  return (
    <Box>
      <Text color={t.success}>✓ </Text>
      <Text color={t.text}>
        T{index} {safeTitle}
      </Text>
      {safeFile && <Text color={t.textDim}> {safeFile}</Text>}
      <Text color={t.textDim}> {meta.join(' ')}</Text>
    </Box>
  );
}
