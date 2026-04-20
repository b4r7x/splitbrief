import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';

type UserMessageEvent = Extract<EngineEvent, { type: 'user_message' }>;

export function UserMessageCard({ event }: { event: UserMessageEvent }) {
  const t = useTheme();
  return (
    <Box flexDirection="row">
      <Text color={t.accent}>{'❯ '}</Text>
      <Text color={t.text} bold>{event.text}</Text>
    </Box>
  );
}
