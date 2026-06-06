import { useEffect } from 'react';
import { Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { Session } from '../../core/schemas/session.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';
import { SessionRow } from '../../components/session-row.js';
import { handleSessionSelect } from '../../stores/navigation/session-select.js';

const filterSession = (s: Session, query: string): boolean => filterByFields(s, query, ['feature']);

export function SessionsPicker() {
  const t = useTheme();
  const [{ cols, isSmall }, { projectDir }, { allSessions: sessions }] = useStores(
    terminalSizeStore,
    configStore,
    sessionsStore,
  );

  useEffect(() => {
    sessionsStore.loadAll(projectDir);
  }, [projectDir]);

  const panelWidth = getResponsivePanelWidth({ cols, size: isSmall ? 'small' : 'large' });

  return (
    <FilterableList
      items={sessions}
      filterFn={filterSession}
      getKey={(session) => session.id}
      onConfirm={(session) => handleSessionSelect(session, projectDir)}
      title={`Sessions (${sessions.length})`}
      hint={'\u2191\u2193 navigate  Enter resume/view  Esc close'}
      bordered={false}
      chromeRows={12}
      maxVisible={5}
      width={panelWidth}
      placeholder={
        <Text color={t.textDim}>
          {sessions.length === 0 ? '  No sessions found.' : '  No matching sessions'}
        </Text>
      }
      renderItem={(session, { isCursor }) => (
        <SessionRow session={session} showCursor isCursor={isCursor} />
      )}
    />
  );
}
