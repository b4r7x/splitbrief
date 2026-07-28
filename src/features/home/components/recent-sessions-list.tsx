import { Box, Text } from 'ink';
import type { Session } from '../../../core/schemas/session.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { useTheme } from '../../../components/theme.js';
import { SessionRow } from '../../../components/session-row.js';
import { RecentSessionsShell } from './recent-sessions-shell.js';
import { FilterInput } from '../../../components/filter-input.js';
import { ListViewport } from '../../../components/pickers/list-viewport.js';
import { ROW_ZONE_Z_SCREEN } from '../../../components/pickers/row-zone.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import { filterSession } from '../../../core/sessions/search.js';
import { copyToClipboard } from '../../../lib/clipboard/clipboard.js';
import { isUnmodifiedYInput } from '../../../lib/terminal/text-entry.js';

export const RECENT_SESSIONS_HINT = `↑↓ navigate${SOFT_SEP}⏎ open${SOFT_SEP}y copy${SOFT_SEP}esc back`;

interface RecentSessionsListProps {
  sessions: Session[];
  hasOverlay: boolean;
  onSelect: (session: Session) => void;
  onClose: () => void;
  maxVisible?: number | undefined;
}

export function RecentSessionsList({
  sessions,
  hasOverlay,
  onSelect,
  onClose,
  maxVisible,
}: RecentSessionsListProps) {
  const theme = useTheme();
  const pageSize = maxVisible === undefined ? sessions.length : Math.max(0, maxVisible);
  const list = useFilterableList({
    items: sessions,
    getKey: (session) => session.id,
    filterFn: filterSession,
    isActive: !hasOverlay,
    pageSize,
    onSelect,
    onItemAction: (session) => {
      void copyToClipboard(session.feature);
    },
    onClose,
    upAtStart: 'close',
    customKeys: (input, key, { runSelectedItemAction }) => {
      if (!isUnmodifiedYInput(input, key)) return false;
      runSelectedItemAction();
      return true;
    },
  });
  const { filter, filtered, selectedIndex, selectItem } = list;

  return (
    <RecentSessionsShell>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
        <FilterInput filter={filter} />
      </Box>
      <Box flexDirection="column">
        <ListViewport
          items={filtered}
          selectedIndex={selectedIndex}
          getKey={(session) => session.id}
          rowBudget={pageSize}
          showRemainingCount
          rowZonePrefix="recent-session"
          rowZoneZ={ROW_ZONE_Z_SCREEN}
          {...(hasOverlay
            ? {}
            : {
                onRowActivate: (index: number) => {
                  const session = filtered[index];
                  if (session !== undefined) selectItem(session);
                },
              })}
          placeholder={<Text color={theme.textDim}>No matching sessions</Text>}
          renderItem={(session, { isCursor }) => (
            <SessionRow session={session} cursor={{ kind: 'outdent', isCursor }} />
          )}
        />
      </Box>
    </RecentSessionsShell>
  );
}
