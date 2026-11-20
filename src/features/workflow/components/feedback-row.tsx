import { panelModel, preparationNotice } from '../../../components/preparation-problem.js';
import { sessionSelectStore } from '../../../stores/navigation/session-select.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { SOFT_SEP } from '../../../core/separators.js';
import { feedbackStore, type FeedbackState } from '../../../stores/ui/feedback.js';
import { approvalPromptStore } from '../../../stores/prompts/approval.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { useStores } from '../../../stores/use-many.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { fitKeyLegend, KEY_LEGEND_LEADING } from '../../../components/key-legend.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { layoutNotice, Notice, type NoticeLayout } from '../../../components/notice.js';
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

// A notice takes the rows it needs up to this many, frame included, two less than on home, so a
// halt panel above keeps every action at 60x18: one text row keeps its frame, more drop it.
const NOTICE_MAX_ROWS = 3;

// A continuation uses bars to keep the transcript in place when the cause fits on the legend row.
function layoutFeedback(
  feedback: FeedbackState,
  terminalCols: number,
  problem: ReturnType<typeof panelModel>,
): NoticeLayout | null {
  const standing = feedback.message === null && problem !== null;
  const notice = standing ? preparationNotice(problem) : feedback;
  if (notice.message === null) return null;
  const text = summarizeDisplayLine(notice.message);
  if (!text) return null;
  return layoutNotice(text, notice.severity, {
    maxWidth: getChromeContentWidth(terminalCols),
    maxRows: NOTICE_MAX_ROWS,
    frame: !standing,
  });
}

export function getFeedbackRows(
  feedback: FeedbackState,
  terminalCols: number,
  problem: ReturnType<typeof panelModel> = null,
): number {
  return layoutFeedback(feedback, terminalCols, problem)?.height ?? 1;
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
  const [feedback] = useStores(feedbackStore);
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
  const preparation = sessionSelectStore.use((snapshot) => snapshot.preparation);
  const notice = layoutFeedback(feedback, terminalCols, panelModel(preparation));
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

  // A message keeps the row whether or not a panel owns the keys, as the one notice on the
  // composer's left edge. Every other word keeps the transcript's grammar: a mark in the mark slot —
  // the legend's pointer, the byline's pip, the composer's border — and every word on the text
  // column its chevron opens on. A caller's prose hint leaves the slot empty.
  if (notice !== null) {
    return (
      <Box flexDirection="column" height={notice.height} flexShrink={0}>
        <Notice layout={notice} />
      </Box>
    );
  }
  const keyHintFitted = keyHint === '' ? '' : fitKeyLegend(keyHint, legendWidth);
  let word = '';
  let isLegend = false;
  // A sheet under the row names its own keys, so above it the row carries a message or nothing;
  // a fallback yields to a panel that owns the keys.
  if (!owned && !panelBelow) {
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
  // A hint that opens with `Failed` keeps the state-word voice.
  const severity = word !== '' ? hintStateSeverity(word) : null;
  const wordColor = severity === 'error' ? t.error : severity === 'warning' ? t.warning : null;
  const lead = word === '' ? '' : isLegend ? KEY_LEGEND_LEADING : ' '.repeat(MARK_SLOT_CELLS);

  // A sheet under the row is the panel that owns the footer while it is up. A row with no word
  // then has nothing to stand on, so it leaves no blank line between the sheet and the divider.
  if (word === '' && panelBelow) return null;

  return (
    <Box flexDirection="column" height={1} flexShrink={0}>
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
