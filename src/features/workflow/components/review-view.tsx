import { Box, Text } from 'ink';
import { useEffect } from 'react';
import { renderMarkdownRows } from '../../../components/markdown.js';
import { truncateTerminalDisplayTextStart } from '../../../utils/display-text.js';
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
  const rows = renderMarkdownRows({
    source: content,
    width: documentWidth,
    theme: t,
    decorateSegment: workflowMarkdownRenderSegments,
  });
  const renderedLineCount = getScrollableDocumentLineCount(rows);
  const { contentHeight, showFooter } = getReviewContentLayout(containerHeight, renderedLineCount);
  const clampedOffset = clampScrollableDocumentOffset(offset, renderedLineCount, contentHeight);

  useEffect(() => {
    reviewStore.setRenderedLineCount(filePath ? renderedLineCount : 0);
  }, [filePath, renderedLineCount]);

  if (!filePath) return null;

  return (
    <Box flexDirection="column" height={containerHeight} width={width} overflow="hidden">
      <Box flexDirection="column" width={documentWidth} overflow="hidden">
        <Box height={1} overflow="hidden">
          <Text color={t.review.file}>
            {truncateTerminalDisplayTextStart(filePath, documentWidth)}
          </Text>
        </Box>
        <Divider width={documentWidth} />
        {contentHeight > 0 && (
          <ScrollableDocument
            rows={rows}
            height={contentHeight}
            isActive={false}
            scrollOffset={offset}
            onScrollOffsetChange={reviewStore.setScrollOffset}
          />
        )}
        {showFooter && (
          <Text color={t.textDim}>
            {truncateTerminalDisplayTextStart(
              getFooterText(renderedLineCount, clampedOffset, contentHeight),
              documentWidth,
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function getFooterText(renderedLineCount: number, offset: number, height: number): string {
  const remaining = Math.max(0, renderedLineCount - offset - height);
  return remaining > 0 ? `${remaining} more rows below` : 'end of file';
}
