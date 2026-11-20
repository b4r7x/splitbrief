import { ThemeText as Text, useTheme } from './theme.js';
import { Box } from 'ink';
import { PanelRow } from './overlays/row.js';
import { ListRow } from './list-row/row.js';
import { planListRows, type ListRowModel } from './list-row/plan.js';
import type { Theme } from '../core/theme/palette.js';
import { useStdout } from 'ink';
import { glyph } from '../lib/glyphs.js';
import { SOFT_SEP } from '../core/separators.js';
import type { Session } from '../core/schemas/session.js';
import { getSessionStatusDisplay } from '../core/sessions/display.js';
import { oneLineDisplayText } from '../utils/display-text/sanitize.js';
import { useSharedClock } from '../hooks/use-shared-clock.js';

export type SessionRowCursor =
  | { kind: 'none' }
  | { kind: 'inline'; isCursor: boolean }
  | { kind: 'outdent'; isCursor: boolean };

const NO_ROW_CURSOR: SessionRowCursor = { kind: 'none' };

function formatRelativeTime(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp)) return 'just now';
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

export function sessionRowModel(session: Session, now: number, theme: Theme): ListRowModel {
  const display = getSessionStatusDisplay(session, theme);
  const time = formatRelativeTime(session.completedAt ?? session.startedAt, now);
  const feature = oneLineDisplayText(session.feature);
  return {
    name: display.icon + ' ' + feature,
    nameParts: [
      { text: display.icon + ' ', color: display.color },
      { text: feature, tone: 'text' },
    ],
    trailing: time + SOFT_SEP + display.word,
  };
}

export function SessionRow({ session, cursor = NO_ROW_CURSOR }: SessionRowProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const now = useSharedClock({ active: () => true });
  const selected = isSelected(cursor);
  const [line] = planListRows([sessionRowModel(session, now, t)], { width: stdout.columns });
  if (!line) return null;
  const row = <ListRow line={line} selected={selected} marker={cursor.kind === 'inline'} />;
  if (cursor.kind !== 'outdent') return row;

  return (
    <PanelRow active={selected} width="100%">
      {/* The bar takes the slot cell beside the row, the way the sidebar's live row wears it — one
          cell out, not two, which is where the list's own frame stands. */}
      {cursor.isCursor && (
        <Box position="absolute" marginLeft={-1}>
          <Text color={t.accent} bold>
            {glyph('liveBar')}
          </Text>
        </Box>
      )}
      {row}
    </PanelRow>
  );
}
