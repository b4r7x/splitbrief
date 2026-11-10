import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { Box } from 'ink';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  REVIEW_CONFIRMS_INDENT,
  REVIEW_TYPED_ROW_HINTS,
  reviewConfirmsCount,
  reviewDocumentFit,
  reviewDocumentForm,
  reviewDocumentOptions,
  reviewDocumentRowLines,
  type ReviewArtifact,
} from '../../prompt-rows/approval.js';
import type { ReviewDraftTarget } from '../../review-commands.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { fitKeyLegend } from '../../../../core/key-legend.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { MARK_SLOT_CELLS } from '../../../../components/row-leading.js';
import { MenuRows } from '../../stop/menu-rows.js';
import { RESULT_MENU_UNFOCUSED_LEGEND } from '../../result/options.js';
import { isCommandDraft } from '../../../../core/composer/submission.js';
import { composerLiveStore } from '../../../../stores/ui/composer-live.js';

export interface DocumentReviewPromptProps {
  artifact: ReviewArtifact;
  confirms: readonly string[];
  budgetRows: number;
  selectedIndex: number;
  draft: ReviewDraftTarget | null;
  focused: boolean;
  clampedBoxRows?: number | undefined;
}

/**
 * The gate that releases the next step of the run. Every row names the step it releases, so the
 * panel is the whole legend: nothing outside its border has to teach the keys it owns.
 */
export function DocumentReviewPrompt({
  artifact,
  confirms,
  budgetRows,
  selectedIndex,
  draft,
  focused,
  clampedBoxRows,
}: DocumentReviewPromptProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const options = reviewDocumentOptions(artifact);
  const width = approvalTextWidth(cols);
  const form = reviewDocumentForm({ artifact, confirms, cols, budgetRows });
  const fit = reviewDocumentFit({
    form,
    artifact,
    cols,
    boxRows: clampedBoxRows ?? Number.POSITIVE_INFINITY,
  });
  // The card opened over a draft, so the keys stay in the composer and the legend says what ⏎
  // does there.
  const commandDraft = composerLiveStore.use((state) => isCommandDraft(state.document));
  const composerEmpty = composerLiveStore.use((state) => state.empty);
  const draftLegend = !focused
    ? commandDraft
      ? `⏎ runs the command${SOFT_SEP}${RESULT_MENU_UNFOCUSED_LEGEND}`
      : composerEmpty
        ? RESULT_MENU_UNFOCUSED_LEGEND
        : `⏎ request changes with the typed correction${SOFT_SEP}${RESULT_MENU_UNFOCUSED_LEGEND}`
    : draft === null
      ? REVIEW_DOCUMENT_HINTS
      : draft === 'send'
        ? REVIEW_COMMENT_HINTS
        : REVIEW_TYPED_ROW_HINTS;
  // A typed row approves nothing, and neither does ⏎ while the composer holds the keys, so where
  // the legend was shed the confirms rows teach its keys instead. Approve keeps the line: ⏎ still
  // grants what it lists.
  const draftLegendInConfirms =
    (!focused || (draft !== null && draft !== 'approve')) && !form.legend;
  // A panel with no row for the confirms line says it on the row that approves.
  const confirmsOnRow = form.confirmsText !== null && !fit.confirms;

  return (
    <Box
      flexDirection="column"
      {...(form.framed
        ? { borderStyle: borderStyleFor('bold'), borderColor: t.border, paddingX: 1 }
        : {})}
      {...(clampedBoxRows === undefined ? {} : { height: clampedBoxRows })}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      {form.confirmsText === null || !fit.confirms ? null : (
        <Box
          paddingLeft={REVIEW_CONFIRMS_INDENT}
          height={form.confirmsText.split('\n').length}
          flexShrink={0}
        >
          {draftLegendInConfirms ? (
            <Text color={t.textDim}>
              {fitKeyLegend(draftLegend, width - REVIEW_CONFIRMS_INDENT)}
            </Text>
          ) : (
            <Text color={t.warning}>{form.confirmsText}</Text>
          )}
        </Box>
      )}
      <MenuRows
        options={options.map((option) => ({
          parts: reviewDocumentRowLines(option, width).map((line, index) => [
            { text: line, tone: 'text' as const },
            ...(confirmsOnRow && index === 0 && option.command === 'approve'
              ? [{ text: `${SOFT_SEP}${reviewConfirmsCount(confirms)}`, tone: 'warning' as const }]
              : []),
          ]),
        }))}
        selectedIndex={
          draft === null
            ? selectedIndex
            : options.findIndex(
                (option) => option.command === (draft === 'send' ? 'comment' : draft),
              )
        }
        marked={focused}
        rowBudget={fit.listRows}
        width={width}
      />
      {form.framed ? <Text> </Text> : null}
      {/* Stripped of its frame the legend is bare text, so it opens on the text column rather than
          in the column the option cursors above it take. */}
      {form.legend ? (
        <Box paddingLeft={form.framed ? 0 : MARK_SLOT_CELLS}>
          <Text color={t.textDim}>
            {fitKeyLegend(draftLegend, form.framed ? width : Math.max(1, width - MARK_SLOT_CELLS))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
