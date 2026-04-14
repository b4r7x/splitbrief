import { Box, Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../ui/theme.js';

type EscalateEvent = Extract<TuiEvent, { type: 'escalate' }>;

export function EscalateCard({ event }: { event: EscalateEvent }) {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.planner} bold>
          escalate{' '}
        </Text>
        <Text color={t.textDim}>tier {event.tier}</Text>
        {event.hint && <Text color={t.textDim}> — hint</Text>}
      </Box>
      {event.hint && (
        <Box marginLeft={2}>
          <Text color={t.textDim}>{event.hint}</Text>
        </Box>
      )}
    </Box>
  );
}
