import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../ui/theme.js';
import type { Session } from '../../../types.js';
import { getResponsivePanelWidth, terminalSizeStore } from '../../../stores/terminal-size.js';
import { CURSOR, NO_CURSOR, filterByFields } from '../../pickers/picker-utils.js';
import { sessionsStore } from '../../../stores/sessions.js';
import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { routerStore } from '../../../stores/router.js';
import { feedbackStore } from '../../../stores/feedback.js';
import { getSessionStatusDisplay } from '../../../core/sessions/status.js';
import { formatRelativeTime, truncate } from '../../../utils/format.js';
import { FilterableList } from '../../pickers/filterable-list.js';

const filterSession = (s: Session, query: string): boolean =>
  filterByFields(s, query, ['feature']);

interface SessionRowProps {
  session: Session;
  isCursor: boolean;
  featureColWidth: number;
  theme: Theme;
}

function SessionRow({ session, isCursor, featureColWidth, theme: t }: SessionRowProps) {
  const display = getSessionStatusDisplay(session.status, t);
  const feature = truncate(session.feature, featureColWidth).padEnd(featureColWidth);
  const time = formatRelativeTime(session.startedAt);
  return (
    <Box>
      <Text color={isCursor ? t.accent : t.text}>{isCursor ? CURSOR : NO_CURSOR}</Text>
      <Text color={display.color}>{display.icon} </Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{feature}</Text>
      <Text color={t.textDim}>  {time}</Text>
    </Box>
  );
}

function handleSelect(session: Session) {
  if (session.status === 'interrupted') {
    overlayStore.close();
    routerStore.navigate('workflow', { feature: session.feature });
    return;
  }
  if (session.summary) {
    overlayStore.close();
    routerStore.navigate('summary', { summary: session.summary });
    return;
  }
  feedbackStore.setMessage(`Session "${session.feature}" failed without a summary to display`);
}

export { handleSelect as handleSelectForTest };

export function SessionsPicker() {
  const t = useTheme();
  const cols = terminalSizeStore.use(s => s.cols);
  const isSmall = terminalSizeStore.use(s => s.isSmall);
  const projectDir = configStore.use(s => s.projectDir);
  const sessions = sessionsStore.use(s => s.allSessions);

  useEffect(() => {
    sessionsStore.loadAll(projectDir);
  }, [projectDir]);

  const panelWidth = getResponsivePanelWidth(cols, isSmall);
  const featureColWidth = Math.max(8, Math.min(isSmall ? 28 : 40, Math.max(1, panelWidth - 8)));

  return (
    <FilterableList
      items={sessions}
      filterFn={filterSession}
      getKey={(session) => session.id}
      onConfirm={handleSelect}
      title={`Sessions (${sessions.length})`}
      hint={'\u2191\u2193 navigate  Enter resume/view  Esc close'}
      bordered={false}
      chromeRows={12}
      maxVisible={5}
      width={panelWidth}
      placeholder={(
        <Text color={t.textDim}>
          {sessions.length === 0 ? '  No sessions found.' : '  No matching sessions'}
        </Text>
      )}
      renderItem={(session, { isCursor }) => (
        <SessionRow
          session={session}
          isCursor={isCursor}
          featureColWidth={featureColWidth}
          theme={t}
        />
      )}
    />
  );
}
