import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { renderMarkdownLine } from '../../../components/markdown.js';
import { getReviewContentLayout } from '../layout/rect.js';
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
  const { contentHeight, showFooter } = getReviewContentLayout(containerHeight, lines.length);
  const visibleLines = lines.slice(offset, offset + contentHeight);

  return (
    <Box flexDirection="column" height={containerHeight} width={width} overflow="hidden">
      <Text color={t.review.file}>{filePath}</Text>
      <Text color={t.border}>{'─'.repeat(Math.max(0, (width ?? 40) - 1))}</Text>
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
