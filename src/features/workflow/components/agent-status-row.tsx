import { Box } from 'ink';
import { eventsStore } from '../../../stores/workflow/events.js';
import { PlannerStatusCard } from './event-cards/planner-status.js';
import { createLatestEventByTypeSelector } from '../latest-event-selector.js';

const selectLatestPlannerStatus = createLatestEventByTypeSelector('planner_status');

export function AgentStatusRow() {
  const latestStatus = eventsStore.use(selectLatestPlannerStatus);

  if (!latestStatus) return <Box height={1} />;

  return (
    <Box height={1} overflow="hidden" flexShrink={0} paddingX={1}>
      <PlannerStatusCard event={latestStatus} chrome />
    </Box>
  );
}
