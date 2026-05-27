import { Box } from 'ink';
import { eventsStore } from '../../../stores/workflow/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getChromeContentWidth } from '../../../core/layout/chrome-rows.js';
import { getWorkflowConfigDensity, WorkflowConfigCard } from './event-cards/workflow-config-card.js';
import { createLatestEventByTypeSelector } from './latest-event-selector.js';

const selectLatestWorkflowConfig = createLatestEventByTypeSelector('workflow_config');

export function ConfigLine() {
  const configEvent = eventsStore.use(selectLatestWorkflowConfig);
  const cols = terminalSizeStore.use(s => s.cols);

  if (!configEvent) return null;

  const contentWidth = getChromeContentWidth(cols);

  return (
    <Box height={1} overflow="hidden" flexShrink={0} paddingX={1}>
      <WorkflowConfigCard event={configEvent} density={getWorkflowConfigDensity(configEvent, contentWidth)} />
    </Box>
  );
}
