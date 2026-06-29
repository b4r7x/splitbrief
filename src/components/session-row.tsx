import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';
import { SOFT_SEP } from './separators.js';
import type { Session } from '../core/schemas/session.js';
import { getSessionStatusDisplay } from '../core/sessions/display.js';
import { sanitizeTerminalDisplayText } from '../utils/display-text.js';

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
  copyHint?: boolean;
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

export function SessionRow({ session, cursor = NO_ROW_CURSOR, copyHint = false }: SessionRowProps) {
  const t = useTheme();
  const display = getSessionStatusDisplay(session.status, t);
  const failed = session.status === 'failed';
  const icon = display.icon;
  const iconColor = display.color;
  const time = formatRelativeTime(session.startedAt);
  const feature = sanitizeTerminalDisplayText(session.feature);
  const selected = isSelected(cursor);
  const bg = selected ? t.selectionBg : undefined;
  const liveBar = `${glyph('liveBar')} `;
  const row = (
    <Box width="100%" backgroundColor={bg}>
      {cursor.kind === 'inline' && (
        <Box flexShrink={0} backgroundColor={bg}>
          <Text color={t.accent} bold>
            {selected ? liveBar : '  '}
          </Text>
        </Box>
      )}
      <Box flexShrink={0} backgroundColor={bg}>
        <Text color={iconColor} bold={selected}>
          {icon}{' '}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} backgroundColor={bg}>
        <Text color={selected ? t.accent : t.text} bold={selected} wrap="truncate-end">
          {feature}
        </Text>
      </Box>
      <Box flexShrink={0} justifyContent="flex-end" backgroundColor={bg}>
        <Text wrap="truncate-end">
          <Text color={t.textDim}> {time}</Text>
          {failed && (
            <>
              <Text color={t.textDim}>{SOFT_SEP}</Text>
              <Text color={t.error} dimColor>
                failed
              </Text>
            </>
          )}
          {copyHint && selected && <Text color={t.textDim}>{`${SOFT_SEP}y copy`}</Text>}
        </Text>
      </Box>
    </Box>
  );

  if (cursor.kind !== 'outdent') return row;

  return (
    <Box width="100%" backgroundColor={bg}>
      {cursor.isCursor && (
        <Box position="absolute" marginLeft={-2} backgroundColor={bg}>
          <Text color={t.accent} bold>
            {liveBar}
          </Text>
        </Box>
      )}
      {row}
    </Box>
  );
}
