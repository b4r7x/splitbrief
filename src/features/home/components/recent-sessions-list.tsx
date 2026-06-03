import type { Key } from 'ink';
import type { Session } from '../../../core/schemas/session.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import { SessionRow } from '../../../components/session-row.js';
import { RecentSessionsShell } from './recent-sessions-shell.js';

const browseAll = (): boolean => true;
const blockChars = (): boolean => false;

interface RecentSessionsListProps {
  sessions: Session[];
  hasOverlay: boolean;
  onSelect: (session: Session) => void;
  onClose: () => void;
}

export function RecentSessionsList({
  sessions,
  hasOverlay,
  onSelect,
  onClose,
}: RecentSessionsListProps) {
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

  const { filtered, selectedIndex } = useFilterableList<Session>({
    items: sessions,
    filterFn: browseAll,
    onSelect,
    onClose,
    isActive: !hasOverlay,
    shouldAppendChar: blockChars,
    initialIndex: 0,
    customKeys,
  });

  return (
    <RecentSessionsShell>
      {filtered.map((s, i) => (
        <SessionRow key={s.id} session={s} showCursor isCursor={i === selectedIndex} />
      ))}
    </RecentSessionsShell>
  );
}
