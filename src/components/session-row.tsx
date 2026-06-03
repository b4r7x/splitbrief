import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import type { Session } from '../core/schemas/session.js';
import { getSessionStatusDisplay } from '../core/sessions/display.js';
import { CursorCell } from './pickers/cursor-cell.js';

function formatRelativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'just now';
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return 'just now';

  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

interface SessionRowProps {
  session: Session;
  showCursor?: boolean;
  isCursor?: boolean;
}

export function SessionRow({ session, showCursor = false, isCursor = false }: SessionRowProps) {
  const t = useTheme();
  const display = getSessionStatusDisplay(session.status, t);
  const time = formatRelativeTime(session.startedAt);
  const selected = showCursor && isCursor;
  const bg = selected ? t.selectionBg : undefined;
  return (
    <Box width="100%" backgroundColor={bg}>
      {showCursor && (
        <Box flexShrink={0} backgroundColor={bg}>
          <CursorCell isCursor={isCursor} />
        </Box>
      )}
      <Box flexShrink={0} backgroundColor={bg}>
        <Text color={display.color}>{display.icon} </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} backgroundColor={bg}>
        <Text color={selected ? t.accent : t.text} bold={selected} wrap="truncate-end">
          {session.feature}
        </Text>
      </Box>
      <Box flexShrink={0} backgroundColor={bg}>
        <Text color={t.textDim}> {time}</Text>
      </Box>
    </Box>
  );
}
