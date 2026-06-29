import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { getMethodDisplay } from '../../../core/sessions/display.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { formatDuration } from '../../../utils/format-time.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';

interface TaskSummaryProps {
  index: number;
  title: string;
  method: TaskCompletionMethod;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  reason?: string | undefined;
  focused?: boolean | undefined;
}

export function TaskSummary({
  index,
  title,
  method,
  retries,
  duration,
  file,
  reason,
  focused,
}: TaskSummaryProps) {
  const t = useTheme();
  const safeTitle = sanitizeTerminalDisplayText(title);
  const safeFile = file === undefined ? undefined : sanitizeTerminalDisplayText(file);
  const safeReason = reason === undefined ? undefined : sanitizeTerminalDisplayText(reason);
  const leadingSlot =
    focused === true ? (
      <Text color={t.accent} bold>
        {`${glyph('liveBar')} `}
      </Text>
    ) : (
      <Text color={t.textDim}>{'  '}</Text>
    );

  if (method === 'failed') {
    return (
      <Box>
        <Text wrap="truncate-end">
          {leadingSlot}
          <Text color={t.textDim}>
            T{index} {safeTitle}
          </Text>
          <Text color={t.error} dimColor>
            {' failed'}
          </Text>
        </Text>
      </Box>
    );
  }

  if (method === 'skipped') {
    return (
      <Box>
        <Text wrap="truncate-end">
          {leadingSlot}
          <Text color={t.textDim}>
            T{index} {safeTitle} skipped{safeReason ? `${SOFT_SEP}${safeReason}` : ''}
          </Text>
        </Text>
      </Box>
    );
  }

  const label = getMethodDisplay(method, t).text;
  const meta: string[] = [label];
  if (retries && retries > 0) meta.push(`${retries} ${retries === 1 ? 'retry' : 'retries'}`);
  if (duration != null) meta.push(formatDuration(duration));
  const tail = [safeFile, ...meta].filter((part) => part !== undefined && part !== '');

  return (
    <Box>
      <Text wrap="truncate-end">
        {leadingSlot}
        <Text color={t.success}>{glyph('check')} </Text>
        <Text color={t.text}>
          T{index} {safeTitle}
        </Text>
        {tail.length > 0 && (
          <Text color={t.textDim}>
            {SOFT_SEP}
            {tail.join(SOFT_SEP)}
          </Text>
        )}
      </Text>
    </Box>
  );
}
