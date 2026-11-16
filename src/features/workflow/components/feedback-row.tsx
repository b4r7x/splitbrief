import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { glyph } from '../../../lib/glyphs.js';
import { Box } from 'ink';
import { SOFT_SEP } from '../../../core/separators.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { approvalPromptStore } from '../../../stores/prompts/approval.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { useStores } from '../../../stores/use-many.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { fitKeyLegend, KEY_LEGEND_LEADING } from '../../../components/key-legend.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { fitFeedbackMessage } from '../../../components/composer/feedback-fit.js';
import { hintStateSeverity, resolveInputHint } from '../input-hints.js';
import { questionPromptStore } from '../../../stores/prompts/question.js';
import { useStopByline } from '../stop/use-byline.js';

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

// A message takes the rows it needs up to this many, one less than on home, so a halt panel above
// keeps every action at 60x18.
const FEEDBACK_MAX_ROWS = 3;

// A message keeps its first line, wrapped onto the rows it needs beside the mark slot.
function fitMessage(message: string, terminalCols: number): string {
  return fitFeedbackMessage(summarizeDisplayLine(message), {
    width: getChromeContentWidth(terminalCols) - MARK_SLOT_CELLS,
    maxRows: FEEDBACK_MAX_ROWS,
  });
}

/** The rows the feedback row takes on a terminal `terminalCols` wide: one, or the rows its message needs. */
export function getFeedbackRows(message: string | null, terminalCols: number): number {
  return message === null ? 1 : fitMessage(message, terminalCols).split('\n').length;
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
  const questions = questionPromptStore.use((s) => s.questions);
  const approvalPending = approvalPromptStore.use((s) => s.status === 'pending');
  const running = lifecycleStore.use((s) => s.status === 'running');
  const stopped = useStopByline();
  const terminalCols = terminalSizeStore.use((s) => s.cols);
  const cols = getChromeContentWidth(terminalCols);
  const t = useTheme();

  // A panel that is on screen owns the legend. Anything this row could add beside it would either
  // repeat a key the panel already names or advertise one the panel has taken away. Question mode
  // owns the row only while a question panel is on screen (questions?.length !== 0): undefined
  // means a recovery or hint panel is up, and [] means Esc closed the round or the reply is prose.
  const owned =
    approvalPending ||
    inputMode === 'review' ||
    (inputMode === 'question' && questions?.length !== 0);
  const messageWord = message === null ? '' : fitMessage(message, terminalCols);
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
  // prose hint leaves the slot empty and still opens on the text column, and a failure fills it.
  const keyHintFitted = keyHint === '' ? '' : fitKeyLegend(keyHint, legendWidth);
  let word = '';
  let isLegend = false;
  // A sheet under the row names its own keys, so above it the row carries a message or nothing. A
  // message keeps the row whether or not a panel owns the keys; only a fallback yields to the panel.
  if (messageWord !== '' || !owned) {
    if (messageWord !== '') word = messageWord;
    else if (!panelBelow) {
      if (stopHint !== '') {
        word = stopHint;
        isLegend = true;
      } else if (keyHintFitted !== '') {
        word = keyHintFitted;
        isLegend = true;
      } else {
        const inputWord = summarizeDisplayLine(resolveInputHint({ inputHint, inputMode }));
        if (inputWord !== '') word = inputWord;
        else if (runningHint !== '') {
          word = runningHint;
          isLegend = true;
        }
      }
    }
  }
  // A failure is its own grammar: the failed mark takes the error ink and the sentence takes the
  // text ink. A hint that opens with `Failed` keeps the state-word voice.
  const failed = isError && !isLegend && word !== '';
  const severity = failed ? null : word !== '' ? hintStateSeverity(word) : null;
  const wordColor = severity === 'error' ? t.error : severity === 'warning' ? t.warning : null;
  const lead =
    word === ''
      ? ''
      : failed
        ? `${glyph('statusFailed')} `
        : isLegend
          ? KEY_LEGEND_LEADING
          : ' '.repeat(MARK_SLOT_CELLS);

  // A sheet under the row is the panel that owns the footer while it is up. A row with no word
  // then has nothing to stand on, so it leaves no blank line between the sheet and the divider.
  if (word === '' && panelBelow) return null;

  // A message past one row goes on under the first, its mark slot empty, in the ink of its words.
  const [first = '', ...more] = word.split('\n');
  return (
    <Box flexDirection="column" height={1 + more.length} flexShrink={0}>
      {first &&
        (failed ? (
          <Text wrap="truncate-end">
            <Text color={t.error}>{lead}</Text>
            <Text color={t.text}>{first}</Text>
          </Text>
        ) : wordColor !== null ? (
          <StateWordVoice lead={lead} text={first} color={wordColor} />
        ) : (
          <Text color={t.textDim} wrap="truncate-end">
            {lead}
            {first}
          </Text>
        ))}
      {more.map((row, index) => (
        <Text key={`${index}:${row}`} color={failed ? t.text : t.textDim} wrap="truncate-end">
          {' '.repeat(MARK_SLOT_CELLS)}
          {row}
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
