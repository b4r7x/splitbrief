import { Box } from 'ink';
import { eventsStore } from '../../../stores/workflow/events.js';
import { operationsStore, type OperationsState } from '../../../stores/workflow/operations.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { createLatestEventByTypeSelector } from '../latest-event-selector.js';
import { OperationStatusCard } from './event-cards/operation-status.js';

const selectLatestPlannerHeartbeat = createLatestEventByTypeSelector('planner_heartbeat');

function selectVisibleOperation(state: OperationsState) {
  return state.active ?? state.last;
}

export function AgentStatusRow() {
  const operation = operationsStore.use(selectVisibleOperation);
  const plannerHeartbeat = eventsStore.use(selectLatestPlannerHeartbeat);
  const cols = terminalSizeStore.use((state) => state.cols);

  if (!operation) return <Box height={1} />;

  return (
    <Box height={1} overflow="hidden" flexShrink={0} paddingX={1}>
      <OperationStatusCard
        operation={operation}
        plannerHeartbeat={plannerHeartbeat}
        width={getChromeContentWidth(cols)}
        chrome
      />
    </Box>
  );
}
