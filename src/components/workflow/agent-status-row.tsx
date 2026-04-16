import { Box } from 'ink';
import { workflowStore } from '../../stores/workflow.js';
import { PlannerStatusCard } from '../event-cards/planner-status-card.js';

export function AgentStatusRow() {
  const events = workflowStore.use(s => s.events);

  // Find the latest planner-status event
  let latestStatus: Extract<typeof events[number], { type: 'planner-status' }> | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'planner-status') {
      latestStatus = ev;
      break;
    }
  }

  if (!latestStatus) return <Box height={1} />;

  return (
    <Box flexShrink={0} paddingX={1}>
      <PlannerStatusCard event={latestStatus} />
    </Box>
  );
}
