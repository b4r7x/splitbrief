import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect } from 'react';

import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterableList } from '../../components/pickers/filterable-list.js';
import { SessionRow } from '../../components/session-row.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  handleSessionSelect,
  sessionSelectStore,
  type SessionSelectDeps,
} from '../../stores/navigation/session-select.js';
import { filterSession } from '../../core/sessions/search.js';
import { sessionSelectDeps } from '../prepare-resume.js';

const SESSION_PICKER_HINT = `\u2191\u2193 select${SOFT_SEP}type filter${SOFT_SEP}\u23ce open${SOFT_SEP}esc close`;

export function SessionsPicker({ deps = sessionSelectDeps }: { deps?: SessionSelectDeps } = {}) {
  const t = useTheme();
  const selectionError = sessionSelectStore.use((s) => s.error);
  const [{ projectDir }, { sessions }] = useStores(configStore, sessionsStore);

  useEffect(() => {
    sessionSelectStore.clearError();
    return () => sessionSelectStore.clearError();
  }, []);

  const hint = selectionError ? selectionError : SESSION_PICKER_HINT;

  return (
    <FilterableList
      items={sessions}
      filterFn={filterSession}
      getKey={(session) => session.id}
      onConfirm={(session) => handleSessionSelect(session, projectDir, deps)}
      title={`Sessions${SOFT_SEP}${sessions.length}`}
      hint={hint}
      chromeRows={12}
      listFloor={0}
      density="roomy"
      placeholder={
        <Text color={t.textDim}>
          {sessions.length === 0
            ? 'No sessions yet — run a task to start one'
            : 'No matching sessions'}
        </Text>
      }
      renderItem={(session, { isCursor }) => (
        <SessionRow session={session} cursor={{ kind: 'inline', isCursor }} />
      )}
    />
  );
}
