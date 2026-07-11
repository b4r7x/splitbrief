import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { abortStore, type ArmedKind } from '../../../stores/workflow/abort.js';
import { useStores } from '../../../stores/use-stores.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { WORKFLOW_CONTENT_PADDING_X } from '../layout/rect.js';
import { hintStateSeverity } from '../input-hints.js';

const ARMED_MESSAGES: Record<Exclude<ArmedKind, 'none'>, string> = {
  exit: 'Ctrl+C again to exit',
  interrupt: 'Esc again to interrupt',
  cancel: 'Esc again to cancel workflow',
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
  const t = useTheme();

  const safeInputHint = summarizeDisplayLine(inputHint);
  const safeMessage = message === null ? null : summarizeDisplayLine(message);
  const feedbackMessage =
    safeMessage && safeInputHint ? `${safeMessage} ${safeInputHint}` : safeMessage;
  const displayMessage =
    armed !== 'none' ? ARMED_MESSAGES[armed] : (feedbackMessage ?? safeInputHint);
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
