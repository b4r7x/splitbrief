import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { abortStore, type ArmedKind } from '../../../stores/workflow/abort.js';
import { useStores } from '../../../stores/use-stores.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { WORKFLOW_CONTENT_PADDING_X } from '../layout/rect.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewKeysStore } from '../../../stores/ui/review-keys.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { hintStateSeverity, resolveReviewKeyLegend } from '../input-hints.js';

const ARMED_MESSAGES: Record<Exclude<ArmedKind, 'none'>, string> = {
  exit: 'ctrl+c again to exit',
  interrupt: 'esc again to interrupt',
  cancel: 'esc again to cancel workflow',
};

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
  const [{ message, isError }] = useStores(feedbackStore);
  const armed = abortStore.use((s) => s.armed);
  const inReviewMode = controlsStore.use((s) => s.inputMode === 'review');
  const reviewKeysArmed = reviewKeysStore.use((s) => s.armed);
  const cols = terminalSizeStore.use((s) => s.cols) - WORKFLOW_CONTENT_PADDING_X * 2;
  const t = useTheme();

  const safeInputHint = summarizeDisplayLine(
    resolveReviewKeyLegend({ inputHint, inReviewMode, reviewKeysArmed, width: cols }),
  );
  const safeMessage = message === null ? null : summarizeDisplayLine(message);
  // Feedback owns the row while it is live and the key legend returns when it clears;
  // appending the legend produced run-on lines like
  // "Failed to open editor: … y approve · c comment · q reject · e edit".
  const displayMessage = armed !== 'none' ? ARMED_MESSAGES[armed] : safeMessage || safeInputHint;
  const showArmed = armed !== 'none';
  const severity = showArmed
    ? null
    : isError
      ? 'error'
      : displayMessage
        ? hintStateSeverity(displayMessage)
        : null;
  const wordColor = severity === 'error' ? t.error : severity === 'warning' ? t.warning : null;

  return (
    <Box height={1} paddingX={WORKFLOW_CONTENT_PADDING_X} flexShrink={0}>
      {displayMessage &&
        (wordColor !== null ? (
          <StateWordVoice text={displayMessage} color={wordColor} />
        ) : (
          <Text color={showArmed ? t.warning : t.textDim} wrap="truncate-end">
            {displayMessage}
          </Text>
        ))}
    </Box>
  );
}

function StateWordVoice({ text, color }: { text: string; color: string }) {
  const t = useTheme();
  const spaceIndex = text.indexOf(' ');
  if (spaceIndex === -1) {
    return (
      <Text color={color} wrap="truncate-end">
        {text}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{text.slice(0, spaceIndex)}</Text>
      <Text color={t.textDim}>{text.slice(spaceIndex)}</Text>
    </Text>
  );
}
