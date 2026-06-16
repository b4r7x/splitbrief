import { Text, type Key } from 'ink';
import type { Session } from '../../../core/schemas/session.js';
import { useTheme } from '../../../components/theme.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import { SessionRow } from '../../../components/session-row.js';
import { RecentSessionsShell } from './recent-sessions-shell.js';
import { FilterInput } from '../../../components/filter-input.js';
import { ListViewport } from '../../../components/pickers/list-viewport.js';
import { availableRows } from '../../../components/pickers/scroll-window.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { filterSession } from '../../../core/sessions/search.js';

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
  const rows = terminalSizeStore.use((s) => s.rows);
  const viewportRows = availableRows(rows, 8);
  const pageSize = maxVisible === undefined ? viewportRows : Math.min(viewportRows, maxVisible);
  const customKeys = (
    _input: string,
    key: Key,
    ctx: { filtered: Session[]; selectedIndex: number },
  ) => {
    if (key.upArrow && ctx.selectedIndex === 0) {
      onClose();
      return true;
    }
    return undefined;
  };

  const { filter, filtered, selectedIndex } = useFilterableList<Session>({
    items: sessions,
    filterFn: filterSession,
    onSelect,
    onClose,
    isActive: !hasOverlay,
    initialIndex: 0,
    pageSize,
    customKeys,
  });

  return (
    <RecentSessionsShell>
      <FilterInput filter={filter} variant="inline" placeholder="type to filter sessions" />
      <ListViewport
        items={filtered}
        selectedIndex={selectedIndex}
        getKey={(session) => session.id}
        chromeRows={8}
        {...(maxVisible !== undefined ? { maxVisible } : {})}
        placeholder={<Text color={theme.textDim}>No matching sessions</Text>}
        renderItem={(session, { isCursor }) => (
          <SessionRow session={session} cursor={{ kind: 'outdent', isCursor }} />
        )}
      />
    </RecentSessionsShell>
  );
}
