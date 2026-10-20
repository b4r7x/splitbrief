import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { formatCopyResult } from '../../../core/runtime/commands/types.js';
import { Box } from 'ink';
import { SOFT_SEP } from '../../../core/separators.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { fitKeyLegend, KEY_LEGEND_LEADING } from '../../../core/key-legend.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
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

export function FeedbackRow({
  inputHint = '',
  keyHint = '',
  panelBelow = false,
}: {
  inputHint?: string | undefined;
  /** A caller's key legend — the row's own mark grammar, not a message's. */
  keyHint?: string | undefined;
  /** A sheet sits under the row and owns the footer's keys; an empty row leaves no blank line. */
  panelBelow?: boolean | undefined;
}) {
  const [{ message, isError }] = useStores(feedbackStore);
  const inputMode = controlsStore.use((s) => s.inputMode);
  const approvalPending = approvalPromptStore.use((s) => s.status === 'pending');
  const running = lifecycleStore.use((s) => s.status === 'running');
  const stopped = useStopByline();
  const cols = getChromeContentWidth(terminalSizeStore.use((s) => s.cols));
  const t = useTheme();

  // A panel that is on screen owns the legend. Anything this row could add beside it would either
  // repeat a key the panel already names or advertise one the panel has taken away.
  const owned = approvalPending || inputMode !== 'normal';
  const safeMessage = message === null ? null : summarizeDisplayLine(message);
  // One cell short of the edge: a legend that ends in the last column reads as cut off even when
  // every token it names is whole. The leading is spent before the keys are fitted.
  const legendWidth = cols - 1 - KEY_LEGEND_LEADING.length;
  const runningHint = running ? fitKeyLegend(RUNNING_LEGEND, legendWidth) : '';
  // A seat change stops nothing, so the run keeps the keys it answers to after the seat's words.
  const stopHint =
    stopped === null || stopped.hint === ''
      ? ''
      : fitKeyLegend(
          stopped.parts.length === 0 && runningHint !== ''
            ? `${stopped.hint}${SOFT_SEP}${RUNNING_LEGEND}`
            : stopped.hint,
          legendWidth,
        );

  // The footer keeps the transcript's grammar: a mark in the mark slot — the legend's pointer, the
  // byline's pip, the composer's border — and every word on the text column its chevron opens on.
  // Every key legend carries the mark, whichever seat it arrived from; a message or a caller's
  // prose hint leaves the slot empty and still opens on the text column.
  const messageWord = safeMessage ?? '';
  const keyHintFitted = keyHint === '' ? '' : fitKeyLegend(keyHint, legendWidth);
  let word = '';
  let isLegend = false;
  const copyReceipt = (['native', 'tmux-buffer', 'osc52'] as const).some(
    (outcome) => messageWord === formatCopyResult(outcome),
  );
  // A sheet under the row names its own keys, so above it the row carries a message or nothing.
  if (!owned || isError || copyReceipt || messageWord === 'Press ctrl+c again to quit') {
    if (messageWord !== '') word = messageWord;
    else if (!panelBelow) {
      if (stopHint !== '') {
        word = stopHint;
        isLegend = true;
      } else if (keyHintFitted !== '') {
        word = keyHintFitted;
        isLegend = true;
      } else {
        const inputWord = summarizeDisplayLine(inputHint);
        if (inputWord !== '') word = inputWord;
        else if (runningHint !== '') {
          word = runningHint;
          isLegend = true;
        }
      }
    }
  }
  const severity = isError ? 'error' : word !== '' ? hintStateSeverity(word) : null;
  const wordColor = severity === 'error' ? t.error : severity === 'warning' ? t.warning : null;
  const lead = word === '' ? '' : isLegend ? KEY_LEGEND_LEADING : ' '.repeat(MARK_SLOT_CELLS);

  // A sheet under the row is the panel that owns the footer while it is up. A row with no word
  // then has nothing to stand on, so it leaves no blank line between the sheet and the divider.
  if (word === '' && panelBelow) return null;

  return (
    <Box height={1} flexShrink={0}>
      {word &&
        (wordColor !== null ? (
          <StateWordVoice lead={lead} text={word} color={wordColor} />
        ) : (
          <Text color={t.textDim} wrap="truncate-end">
            {lead}
            {word}
          </Text>
        ))}
    </Box>
  );
}

function StateWordVoice({
  lead,
  text,
  color,
}: {
  lead: string;
  text: string;
  color: string | undefined;
}) {
  const t = useTheme();
  const spaceIndex = text.indexOf(' ');
  if (spaceIndex === -1) {
    return (
      <Text wrap="truncate-end">
        <Text color={t.textDim}>{lead}</Text>
        <Text color={color}>{text}</Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={t.textDim}>{lead}</Text>
      <Text color={color}>{text.slice(0, spaceIndex)}</Text>
      <Text color={t.textDim}>{text.slice(spaceIndex)}</Text>
    </Text>
  );
}
