import { Box } from 'ink';
import { workflowStore } from '../../stores/workflow.js';
import { WorkflowConfigCard } from '../event-cards/workflow-config-card.js';

export function ConfigLine() {
  const events = workflowStore.use(s => s.events);

  // Find the latest workflow-config event
  let configEvent: Extract<typeof events[number], { type: 'workflow-config' }> | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'workflow-config') {
      configEvent = ev;
      break;
    }
  }

  if (!configEvent) return null;

  return (
    <Box flexShrink={0} paddingX={1}>
      <WorkflowConfigCard event={configEvent} />
    </Box>
  );
}
