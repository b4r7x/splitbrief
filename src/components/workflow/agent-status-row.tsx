import { Box } from 'ink';
import { workflowStore } from '../../stores/workflow.js';
import { findLatestEventByType } from '../../core/event-sections.js';
import { PlannerStatusCard } from '../event-cards/planner-status-card.js';

export function AgentStatusRow() {
  const events = workflowStore.use(s => s.events);
  const latestStatus = findLatestEventByType(events, 'planner-status');

  if (!latestStatus) return <Box height={1} />;

  return (
    <Box flexShrink={0} paddingX={1}>
      <PlannerStatusCard event={latestStatus} />
    </Box>
  );
}
