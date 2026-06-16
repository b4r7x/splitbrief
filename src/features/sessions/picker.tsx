import { useEffect } from 'react';
import { Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';
import { SessionRow } from '../../components/session-row.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
import { filterSession } from '../../core/sessions/search.js';

const SESSION_PICKER_HINT = '\u2191\u2193 navigate  Type filter  Enter resume/view  Esc close';

export function SessionsPicker() {
  const t = useTheme();
  const selectionError = sessionSelectStore.use((s) => s.error);
  const [{ cols, isSmall }, { projectDir }, { allSessions: sessions }] = useStores(
    terminalSizeStore,
    configStore,
    sessionsStore,
  );

  useEffect(() => {
    sessionsStore.loadAll(projectDir);
  }, [projectDir]);

  useEffect(() => {
    sessionSelectStore.clearError();
    return () => sessionSelectStore.clearError();
  }, []);

  const panelWidth = getResponsivePanelWidth({ cols, size: isSmall ? 'small' : 'large' });
  const hint = selectionError ? `Error: ${selectionError}` : SESSION_PICKER_HINT;

  return (
    <FilterableList
      items={sessions}
      filterFn={filterSession}
      getKey={(session) => session.id}
      onConfirm={(session) => handleSessionSelect(session, projectDir)}
      title={`Sessions (${sessions.length})`}
      hint={hint}
      bordered={false}
      chromeRows={12}
      listFloor={0}
      maxVisible={5}
      width={panelWidth}
      placeholder={
        <Text color={t.textDim}>
          {sessions.length === 0 ? '  No sessions found.' : '  No matching sessions'}
        </Text>
      }
      renderItem={(session, { isCursor }) => (
        <SessionRow session={session} cursor={{ kind: 'inline', isCursor }} />
      )}
    />
  );
}
