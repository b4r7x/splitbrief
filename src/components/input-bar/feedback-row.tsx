import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { feedbackStore } from '../../stores/feedback.js';
import { abortStore } from '../../stores/abort.js';
import { useStores } from '../../stores/use-stores.js';

export function FeedbackRow() {
  const [{ message, isError }, { pending: abortPending }] = useStores(feedbackStore, abortStore);
  const t = useTheme();

  const displayMessage = abortPending ? 'Ctrl+C again within 2s to exit' : message;
  const displayColor = abortPending ? t.warning : (isError ? t.error : t.info);

  return (
    <Box height={1} paddingX={2} flexShrink={0}>
      {displayMessage && <Text color={displayColor}>{displayMessage}</Text>}
    </Box>
  );
}
