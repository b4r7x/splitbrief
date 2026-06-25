import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import type { Session } from '../core/schemas/session.js';
import { getSessionStatusDisplay } from '../core/sessions/display.js';
import { CursorCell } from './pickers/cursor-cell.js';

export type SessionRowCursor =
  | { kind: 'none' }
  | { kind: 'inline'; isCursor: boolean }
  | { kind: 'outdent'; isCursor: boolean };

const NO_ROW_CURSOR: SessionRowCursor = { kind: 'none' };

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
  cursor?: SessionRowCursor;
}

function isSelected(cursor: SessionRowCursor): boolean {
  switch (cursor.kind) {
    case 'none':
      return false;
    case 'inline':
    case 'outdent':
      return cursor.isCursor;
    default: {
      const _exhaustive: never = cursor;
      return _exhaustive;
    }
  }
}

export function SessionRow({ session, cursor = NO_ROW_CURSOR }: SessionRowProps) {
  const t = useTheme();
  const display = getSessionStatusDisplay(session.status, t);
  const time = formatRelativeTime(session.startedAt);
  const selected = isSelected(cursor);
  const bg = selected ? t.selectionBg : undefined;
  const row = (
    <Box width="100%" backgroundColor={bg}>
      {cursor.kind === 'inline' && (
        <Box flexShrink={0} backgroundColor={bg}>
          <CursorCell isCursor={cursor.isCursor} />
        </Box>
      )}
      <Box flexShrink={0} backgroundColor={bg}>
        <Text color={display.color} bold={selected}>
          {display.icon}{' '}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} backgroundColor={bg}>
        <Text color={selected ? t.accent : t.text} bold={selected} wrap="truncate-end">
          {session.feature}
        </Text>
      </Box>
      <Box flexShrink={0} justifyContent="flex-end" backgroundColor={bg}>
        <Text color={t.textDim} wrap="truncate-end">
          {' '}
          {time}
        </Text>
      </Box>
    </Box>
  );

  if (cursor.kind !== 'outdent') return row;

  return (
    <Box width="100%" backgroundColor={bg}>
      {cursor.isCursor && (
        <Box position="absolute" marginLeft={-2} backgroundColor={bg}>
          <CursorCell isCursor />
        </Box>
      )}
      {row}
    </Box>
  );
}
