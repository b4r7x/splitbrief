import { Box } from 'ink';
import { eventsStore } from '../../../stores/workflow/events.js';
import { findLatestEventByType } from '../../../core/layout/event-sections.js';
import { WorkflowConfigCard } from './event-cards/workflow-config-card.js';

export function ConfigLine() {
  const events = eventsStore.use(s => s.events);
  const configEvent = findLatestEventByType(events, 'workflow_config');

  if (!configEvent) return null;

  return (
    <Box flexShrink={0} paddingX={1}>
      <WorkflowConfigCard event={configEvent} />
    </Box>
  );
}
