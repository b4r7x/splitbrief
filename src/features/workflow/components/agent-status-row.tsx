import { Box } from 'ink';
import { eventsStore } from '../../../stores/workflow/events.js';
import { findLatestEventByType } from '../../../core/layout/event-sections.js';
import { PlannerStatusCard } from './event-cards/planner-status-card.js';

export function AgentStatusRow() {
  const events = eventsStore.use(s => s.events);
  const latestStatus = findLatestEventByType(events, 'planner_status');

  if (!latestStatus) return <Box height={1} />;

  return (
    <Box flexShrink={0} paddingX={1}>
      <PlannerStatusCard event={latestStatus} />
    </Box>
  );
}
