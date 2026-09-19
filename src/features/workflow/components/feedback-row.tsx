import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { hintStateSeverity } from '../input-hints.js';
import { useStopByline } from '../stop/use-stop-byline.js';

// The keys a run answers to while it is working. `esc` opens the stop sheet rather than stopping,
// so the word on the row is the sheet, not the stop.
export const RUNNING_LEGEND = `esc stop options${SOFT_SEP}ctrl+c stop now${SOFT_SEP}ctrl+k commands${SOFT_SEP}/help`;

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
  const inputMode = controlsStore.use((s) => s.inputMode);
  const approvalPending = approvalPromptStore.use((s) => s.status === 'pending');
  const running = lifecycleStore.use((s) => s.status === 'running');
  const stopped = useStopByline();
  // The legend is the footer's own furniture, so it opens on the gutter line with the composer's
  // box and the byline's pip — the transcript's text column is the transcript's.
  const cols = getChromeContentWidth(terminalSizeStore.use((s) => s.cols));
  const t = useTheme();

  // A panel that is on screen owns the legend. Anything this row could add beside it would either
  // repeat a key the panel already names or advertise one the panel has taken away.
  const owned = approvalPending || inputMode !== 'normal';
  const safeMessage = message === null ? null : summarizeDisplayLine(message);
  // One cell short of the edge: a legend that ends in the last column reads as cut off even when
  // every token it names is whole.
  const runningHint = running ? fitKeyLegend(RUNNING_LEGEND, cols - 1) : '';
  const stopHint =
    stopped === null || stopped.hint === '' ? '' : fitKeyLegend(stopped.hint, cols - 1);
  const displayMessage =
    owned && !isError && safeMessage !== 'Press ctrl+c again to quit'
      ? ''
      : safeMessage || stopHint || summarizeDisplayLine(inputHint) || runningHint;
  const severity = isError ? 'error' : displayMessage ? hintStateSeverity(displayMessage) : null;
  const wordColor = severity === 'error' ? t.error : severity === 'warning' ? t.warning : null;

  return (
    <Box height={1} flexShrink={0}>
      {displayMessage &&
        (wordColor !== null ? (
          <StateWordVoice text={displayMessage} color={wordColor} />
        ) : (
          <Text color={t.textDim} wrap="truncate-end">
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
