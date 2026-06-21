import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { abortStore, type ArmedKind } from '../../../stores/workflow/abort.js';
import { useStores } from '../../../stores/use-stores.js';
import { WORKFLOW_CONTENT_PADDING_X } from '../layout/rect.js';

const ARMED_MESSAGES: Record<Exclude<ArmedKind, 'none'>, string> = {
  exit: 'Ctrl+C again to exit',
  interrupt: 'Esc again to interrupt',
  cancel: 'Esc again to cancel workflow',
};

export function FeedbackRow() {
  const [{ message, isError }] = useStores(feedbackStore);
  const armed = abortStore.use((s) => s.armed);
  const t = useTheme();

  const displayMessage = armed !== 'none' ? ARMED_MESSAGES[armed] : message;
  const displayColor = armed !== 'none' ? t.warning : isError ? t.error : t.info;

  return (
    <Box height={1} paddingX={WORKFLOW_CONTENT_PADDING_X} flexShrink={0}>
      {displayMessage && <Text color={displayColor}>{displayMessage}</Text>}
    </Box>
  );
}
