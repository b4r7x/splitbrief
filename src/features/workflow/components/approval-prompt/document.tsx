import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { listRowLead } from '../../../../components/list-row.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  REVIEW_CONFIRMS_INDENT,
  reviewDocumentForm,
  reviewDocumentOptions,
  type ReviewArtifact,
} from '../../prompt-rows/approval.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { fitKeyLegend } from '../../../../core/key-legend.js';
import { MARK_SLOT_CELLS } from '../../../../components/row-leading.js';

export interface DocumentReviewPromptProps {
  artifact: ReviewArtifact;
  confirms: readonly string[];
  budgetRows: number;
  selectedIndex: number;
  commenting: boolean;
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
  commenting,
  clampedBoxRows,
}: DocumentReviewPromptProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const options = reviewDocumentOptions(artifact);
  const keyWidth = approvalKeyColumnWidth(options);
  const width = approvalTextWidth(cols);
  const showCursor = !commenting;
  const form = reviewDocumentForm({ artifact, confirms, cols, budgetRows });
  // A comment being typed approves nothing, so where the legend was shed the confirms rows teach
  // the two keys that are still live instead.
  const commentLegendInConfirms = commenting && !form.legend;

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
      {form.confirmsText === null ? null : (
        <Box
          paddingLeft={REVIEW_CONFIRMS_INDENT}
          height={form.confirmsText.split('\n').length}
          flexShrink={0}
        >
          {commentLegendInConfirms ? (
            <Text color={t.textDim}>
              {fitKeyLegend(REVIEW_COMMENT_HINTS, width - REVIEW_CONFIRMS_INDENT)}
            </Text>
          ) : (
            <Text color={t.warning}>{form.confirmsText}</Text>
          )}
        </Box>
      )}
      {options.map((option, index) => {
        const active = showCursor && index === selectedIndex;
        return (
          <Text key={option.key}>
            <Text color={active ? t.accent : t.textDim}>
              {listRowLead(active ? 'active' : 'default')}
            </Text>
            <Text color={t.textDim}>{approvalOptionKeyCell(option, keyWidth)}</Text>
            {'   '}
            <Text color={active ? t.accent : t.text}>
              {approvalOptionLabelText({ option, keyWidth, width })}
            </Text>
          </Text>
        );
      })}
      {form.framed ? <Text> </Text> : null}
      {/* Stripped of its frame the legend is bare text, so it opens on the text column rather than
          in the column the option cursors above it take. */}
      {form.legend ? (
        <Box paddingLeft={form.framed ? 0 : MARK_SLOT_CELLS}>
          <Text color={t.textDim}>
            {fitKeyLegend(
              commenting ? REVIEW_COMMENT_HINTS : REVIEW_DOCUMENT_HINTS,
              form.framed ? width : Math.max(1, width - MARK_SLOT_CELLS),
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
