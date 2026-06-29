import { Box, Text } from 'ink';
import { useEffect } from 'react';
import { renderMarkdownRows } from '../../../components/markdown.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextStart,
} from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { getScrollViewportContentWidth } from '../../../components/scrollbar.js';
import {
  clampScrollableDocumentOffset,
  getScrollableDocumentLineCount,
  ScrollableDocument,
} from '../../../components/scrollable-document.js';
import { Divider } from './divider.js';
import { useTheme } from '../../../components/theme.js';
import { getReviewColumnWidth, getReviewContentLayout } from '../layout/rect.js';
import { useReviewContent } from '../hooks/use-review-content.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { useStores } from '../../../stores/use-stores.js';
import { workflowMarkdownRenderSegments } from '../conversation-rows/markdown-rows.js';

interface ReviewViewProps {
  height?: number;
  width?: number;
}

export function ReviewView({ height, width }: ReviewViewProps) {
  const t = useTheme();
  const [{ filePath, scrollOffset: offset }] = useStores(reviewStore);
  const content = useReviewContent(filePath);
  const containerHeight = height ?? 20;
  const documentWidth = Math.max(1, getReviewColumnWidth(width ?? 80));
  const frameInnerWidth = Math.max(1, documentWidth - 4);
  const scrollableWidth = Math.max(1, documentWidth - 2);
  const bodyWidth = Math.max(1, getScrollViewportContentWidth(scrollableWidth));
  const innerHeight = Math.max(0, containerHeight - 2);
  const rows = renderMarkdownRows({
    source: content,
    width: bodyWidth,
    theme: t,
    decorateSegment: workflowMarkdownRenderSegments,
  });
  const renderedLineCount = getScrollableDocumentLineCount(rows);
  const { contentHeight, showFooter } = getReviewContentLayout(innerHeight, renderedLineCount);
  const clampedOffset = clampScrollableDocumentOffset(offset, renderedLineCount, contentHeight);

  useEffect(() => {
    reviewStore.setRenderedLineCount(filePath ? renderedLineCount : 0);
  }, [filePath, renderedLineCount]);

  if (!filePath) return null;

  const remaining = Math.max(0, renderedLineCount - clampedOffset - contentHeight);
  const footerLabel = remaining > 0 ? `↓  ${remaining} more` : 'end of file';
  const scrollHint = `↑↓ scroll${SOFT_SEP}g/G ends`;
  const showScrollHint =
    remaining > 0 &&
    getTerminalCellWidth(footerLabel) + getTerminalCellWidth(scrollHint) + 2 <= frameInnerWidth;

  return (
    <Box flexDirection="column" height={containerHeight} width={width} overflow="hidden">
      <Box
        flexDirection="column"
        width={documentWidth}
        height={containerHeight}
        borderStyle={borderStyleFor('single')}
        borderColor={t.border}
        borderDimColor
        paddingX={1}
        overflow="hidden"
      >
        <Box height={1} overflow="hidden">
          {renderTitle(filePath, frameInnerWidth, t.textDim, t.text)}
        </Box>
        <Divider width={frameInnerWidth} />
        {contentHeight > 0 && (
          <ScrollableDocument
            rows={rows}
            height={contentHeight}
            width={scrollableWidth}
            isActive={false}
            scrollOffset={offset}
            onScrollOffsetChange={reviewStore.setScrollOffset}
            showScrollbar
            showScrollIndicators={false}
          />
        )}
        {showFooter && (
          <>
            <Divider width={frameInnerWidth} />
            <Box height={1} width={frameInnerWidth} overflow="hidden">
              <Text color={t.textDim}>{footerLabel}</Text>
              <Box flexGrow={1} />
              {showScrollHint && <Text color={t.textDim}>{scrollHint}</Text>}
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}

function renderTitle(filePath: string, width: number, dim: string, fg: string) {
  const pip = '◇ ';
  const pathBudget = Math.max(1, width - getTerminalCellWidth(pip));
  const path = truncateTerminalDisplayTextStart(filePath, pathBudget);
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <Text>
      <Text color={dim}>{pip}</Text>
      {dir !== '' && <Text color={dim}>{dir}</Text>}
      <Text color={fg} bold>
        {base}
      </Text>
    </Text>
  );
}
