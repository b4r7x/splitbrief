import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { NO_CURSOR, cursorGlyph } from '../../../../components/pickers/cursor-glyph.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  isCompactReviewDocument,
  reviewDocumentOptions,
  type ReviewArtifact,
} from '../../prompt-rows/approval.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { fitKeyLegend } from '../../input-hints.js';

export interface DocumentReviewPromptProps {
  artifact: ReviewArtifact;
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
  const compact = isCompactReviewDocument(cols);

  return (
    <Box
      flexDirection="column"
      {...(compact
        ? {}
        : { borderStyle: borderStyleFor('bold'), borderColor: t.border, paddingX: 1 })}
      {...(clampedBoxRows === undefined ? {} : { height: clampedBoxRows })}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      {options.map((option, index) => (
        <Text key={option.key}>
          {showCursor && index === selectedIndex ? (
            <Text color={t.text}>{cursorGlyph()}</Text>
          ) : (
            NO_CURSOR
          )}
          <Text color={t.textDim}>{approvalOptionKeyCell(option, keyWidth)}</Text>
          {'   '}
          {approvalOptionLabelText({ option, keyWidth, width })}
        </Text>
      ))}
      {compact ? null : <Text> </Text>}
      <Text color={t.textDim}>
        {fitKeyLegend(commenting ? REVIEW_COMMENT_HINTS : REVIEW_DOCUMENT_HINTS, width)}
      </Text>
    </Box>
  );
}
