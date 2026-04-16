import { Box } from 'ink';
import { workflowStore } from '../../stores/workflow.js';
import { findLatestEventByType } from '../../core/event-sections.js';
import { WorkflowConfigCard } from '../event-cards/workflow-config-card.js';

export function ConfigLine() {
  const events = workflowStore.use(s => s.events);
  const configEvent = findLatestEventByType(events, 'workflow-config');

  if (!configEvent) return null;

  return (
    <Box flexShrink={0} paddingX={1}>
      <WorkflowConfigCard event={configEvent} />
    </Box>
  );
}
