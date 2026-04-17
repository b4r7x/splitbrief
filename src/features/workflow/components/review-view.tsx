import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { renderMarkdownLine } from '../../../components/markdown.js';
import { getReviewContentHeight } from '../../../core/layout/workflow-rect.js';
import { useReviewContent } from '../hooks/use-review-content.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { useStores } from '../../../stores/use-stores.js';

interface ReviewViewProps {
  height?: number;
  width?: number;
}

export function ReviewView({ height, width }: ReviewViewProps) {
  const t = useTheme();
  const [{ filePath, scrollOffset: offset }] = useStores(reviewStore);
  const content = useReviewContent(filePath);

  if (!filePath) return null;

  const lines = content.split('\n');
  const containerHeight = height ?? 20;
  const contentHeight = getReviewContentHeight(containerHeight, lines.length);
  const visibleLines = lines.slice(offset, offset + contentHeight);
  const showFooter = lines.length > Math.max(0, containerHeight - 1);

  return (
    <Box flexDirection="column" height={containerHeight} width={width} overflow="hidden">
      <Text color={t.review.file}>{filePath}</Text>
      <Box flexDirection="column">
        {visibleLines.map((line, i) => renderMarkdownLine(line, i, t))}
      </Box>
      {showFooter && (
        <Text color={t.textDim}>
          {offset + contentHeight < lines.length
            ? `${lines.length - offset - contentHeight} more lines below`
            : 'end of file'}
        </Text>
      )}
    </Box>
  );
}
