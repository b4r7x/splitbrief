import { Box, Text } from 'ink';
import { useEffect } from 'react';
import { renderReviewRows } from './review-rows-cache.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { getScrollViewportContentWidth } from '../../../components/scrollbar.js';
import { ScrollIndicator } from '../../../components/scroll-indicator.js';
import {
  clampScrollableDocumentOffset,
  getScrollableDocumentLineCount,
  ScrollableDocument,
} from '../../../components/scrollable-document.js';
import { Divider } from './divider.js';
import { FramePanel } from './frame-panel.js';
import { useTheme } from '../../../components/theme.js';
import { getReviewColumnWidth, getReviewContentLayout, REVIEW_FRAME_ROWS } from '../layout/rect.js';
import { normalizeScrollRows } from '../layout/scroll-window.js';
import { useReviewContent } from '../hooks/use-review-content.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { workflowMarkdownRenderSegments } from '../conversation-rows/markdown-rows/review-segments.js';

interface ReviewViewProps {
  height?: number;
  width?: number;
}

export function ReviewView({ height, width }: ReviewViewProps) {
  const t = useTheme();
  const [{ source, scrollOffset: offset }] = useStores(reviewStore);
  const content = useReviewContent(source);
  const containerHeight = normalizeScrollRows(height ?? 20);
  const documentWidth = Math.max(1, getReviewColumnWidth(width ?? 80));
  const frameInnerWidth = Math.max(1, documentWidth - 4);
  const scrollableWidth = Math.max(1, documentWidth - 2);
  const bodyWidth = Math.max(1, getScrollViewportContentWidth(scrollableWidth));
  const innerHeight = Math.max(0, containerHeight - REVIEW_FRAME_ROWS);
  const rows = renderReviewRows({
    source: content,
    width: bodyWidth,
    theme: t,
    decorateSegment: workflowMarkdownRenderSegments,
    projectDir: configStore.get().projectDir,
  });
  const renderedLineCount = getScrollableDocumentLineCount(rows);
  const { contentHeight, showFooter } = getReviewContentLayout(innerHeight, renderedLineCount);
  const clampedOffset = clampScrollableDocumentOffset({
    offset,
    lineCount: renderedLineCount,
    height: contentHeight,
  });

  useEffect(() => {
    reviewStore.setRenderedLineCount(source ? renderedLineCount : 0);
  }, [source, renderedLineCount]);

  if (!source) return null;

  const reviewLabel = source.kind === 'file' ? source.filePath : 'Custom planner artifact';

  const remaining = Math.max(0, renderedLineCount - clampedOffset - contentHeight);
  const scrollIndicatorText = ` ↓ ${remaining} more`;
  const scrollHint = `↑↓ scroll${SOFT_SEP}g/G ends`;
  const showScrollHint =
    remaining > 0 &&
    getTerminalCellWidth(scrollIndicatorText) + getTerminalCellWidth(scrollHint) + 2 <=
      frameInnerWidth;

  return (
    <Box flexDirection="column" height={containerHeight} width={width} overflow="hidden">
      <FramePanel filePath={reviewLabel} width={documentWidth} height={containerHeight}>
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
              {remaining > 0 ? (
                <ScrollIndicator show direction="down" count={remaining} />
              ) : (
                <Text color={t.textDim}>End of file</Text>
              )}
              <Box flexGrow={1} />
              {showScrollHint && <Text color={t.textDim}>{scrollHint}</Text>}
            </Box>
          </>
        )}
      </FramePanel>
    </Box>
  );
}
