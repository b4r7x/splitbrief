import { Box } from 'ink';
import { eventsStore } from '../../../stores/workflow/events.js';
import { WorkflowConfigCard } from './event-cards/workflow-config-card.js';
import { createLatestEventByTypeSelector } from './latest-event-selector.js';

const selectLatestWorkflowConfig = createLatestEventByTypeSelector('workflow_config');

export function ConfigLine() {
  const configEvent = eventsStore.use(selectLatestWorkflowConfig);

  if (!configEvent) return null;

  return (
    <Box flexShrink={0} paddingX={1}>
      <WorkflowConfigCard event={configEvent} />
    </Box>
  );
}
