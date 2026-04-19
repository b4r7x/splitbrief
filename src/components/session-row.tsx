import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import type { Session } from '../core/schemas/session.js';
import { getSessionStatusDisplay } from '../core/sessions/display.js';
import { truncateWithEllipsis } from '../utils/truncate.js';
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
  featureColWidth?: number;
}

export function SessionRow({ session, showCursor = false, isCursor = false, featureColWidth }: SessionRowProps) {
  const t = useTheme();
  const display = getSessionStatusDisplay(session.status, t);
  const feature = featureColWidth !== undefined
    ? truncateWithEllipsis(session.feature, featureColWidth).padEnd(featureColWidth)
    : session.feature;
  const time = formatRelativeTime(session.startedAt);
  const featureColor = showCursor
    ? (isCursor ? t.accent : t.text)
    : t.text;
  return (
    <Box>
      {showCursor && <CursorCell isCursor={isCursor} />}
      <Text color={display.color}>{display.icon} </Text>
      <Text color={featureColor} bold={showCursor && isCursor}>{feature}</Text>
      <Text color={t.textDim}>{showCursor ? '  ' : ' '}{time}</Text>
    </Box>
  );
}
