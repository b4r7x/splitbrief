import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { getProviderDisplayName } from '../../../../core/providers/catalog.js';

type WorkflowConfigEvent = Extract<EngineEvent, { type: 'workflow_config' }>;

export function WorkflowConfigCard({ event }: { event: WorkflowConfigEvent }) {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={t.accent} bold>
        ⚙ Workflow Configuration
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        <Box>
          <Text color={t.textDim}>Mode: </Text>
          <Text color={t.text}>{event.mode}</Text>
        </Box>
        <Box>
          <Text color={t.textDim}>Planner: </Text>
          <Text color={t.planner}>{getProviderDisplayName(event.plannerTool)}</Text>
          {event.plannerModel && <Text color={t.textDim}> ({event.plannerModel})</Text>}
        </Box>
        <Box>
          <Text color={t.textDim}>Implementer: </Text>
          <Text color={t.implementer}>{getProviderDisplayName(event.implementerTool)}</Text>
          {event.implementerModel && <Text color={t.textDim}> ({event.implementerModel})</Text>}
        </Box>
      </Box>
    </Box>
  );
}
