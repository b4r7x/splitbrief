import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { abortStore, type ArmedKind } from '../../../stores/workflow/abort.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { WORKFLOW_CONTENT_PADDING_X } from '../layout/rect.js';

const ARMED_MESSAGES: Record<Exclude<ArmedKind, 'none'>, string> = {
  exit: 'Ctrl+C again to exit',
  interrupt: 'Esc again to interrupt',
  cancel: 'Esc again to cancel workflow',
};

function formatQueueNotice(queueDepth: number): string | null {
  if (queueDepth <= 0) return null;
  const noun = queueDepth === 1 ? 'message' : 'messages';
  return `Queued ${queueDepth} ${noun} pending next planner turn.`;
}

function formatCompactQueueNotice(queueDepth: number): string | null {
  if (queueDepth <= 0) return null;
  return `queued: ${queueDepth}`;
}

function summarizeDisplayLine(text: string): string {
  const safeText = sanitizeTerminalDisplayText(text, { preserveLineBreaks: true });
  return (
    safeText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

export function FeedbackRow({ inputHint = '' }: { inputHint?: string | undefined }) {
  const [{ message, isError }, { queueDepth }] = useStores(feedbackStore, lifecycleStore);
  const armed = abortStore.use((s) => s.armed);
  const t = useTheme();

  const queueNotice = formatQueueNotice(queueDepth);
  const compactQueueNotice = formatCompactQueueNotice(queueDepth);
  const safeInputHint = summarizeDisplayLine(inputHint);
  const safeMessage = message === null ? null : summarizeDisplayLine(message);
  const hintMessage =
    compactQueueNotice && safeInputHint
      ? `${safeInputHint} · ${compactQueueNotice}`
      : (queueNotice ?? safeInputHint);
  const feedbackMessage =
    safeMessage && safeInputHint ? `${safeMessage} ${safeInputHint}` : safeMessage;
  const displayMessage =
    armed !== 'none' ? ARMED_MESSAGES[armed] : (feedbackMessage ?? hintMessage);
  let displayColor = t.textDim;
  if (armed !== 'none') {
    displayColor = t.warning;
  } else if (isError) {
    displayColor = t.error;
  } else if (message || queueNotice) {
    displayColor = t.info;
  }

  return (
    <Box height={1} paddingX={WORKFLOW_CONTENT_PADDING_X} flexShrink={0}>
      {displayMessage && (
        <Text color={displayColor} wrap="truncate-end">
          {displayMessage}
        </Text>
      )}
    </Box>
  );
}
