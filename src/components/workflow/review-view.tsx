import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import fs from 'node:fs/promises';
import { useTheme } from '../../ui/theme.js';
import { renderMarkdownLine } from '../../ui/markdown.js';
import { feedbackStore } from '../../stores/feedback.js';
import { workflowStore } from '../../stores/workflow.js';
import { toErrorMessage } from '../../utils/format.js';

interface ReviewViewProps {
  height?: number;
  width?: number;
}

export function ReviewView({ height, width }: ReviewViewProps) {
  const t = useTheme();
  const filePath = workflowStore.use(s => s.reviewFilePath);
  const offset = workflowStore.use(s => s.reviewScrollOffset);
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    fs.readFile(filePath, 'utf-8').then(data => {
      if (!cancelled) {
        setContent(data);
        workflowStore.setReviewLineCount(data.split('\n').length);
      }
    }).catch((err: unknown) => {
      if (cancelled) return;
      setContent('');
      workflowStore.setReviewLineCount(0);
      feedbackStore.setError(`Failed to read ${filePath}: ${toErrorMessage(err)}`);
    });
    return () => { cancelled = true; };
  }, [filePath]);

  const lines = content.split('\n');
  const visibleHeight = height ?? 20;

  if (!filePath) return null;

  const visibleLines = lines.slice(offset, offset + visibleHeight);

  return (
    <Box flexDirection="column" height={visibleHeight} width={width} overflow="hidden">
      <Text color={t.review.file}>{filePath}</Text>
      <Box flexDirection="column">
        {visibleLines.map((line, i) => renderMarkdownLine(line, i, t))}
      </Box>
      {lines.length > visibleHeight && (
        <Text color={t.textDim}>
          {offset + visibleHeight < lines.length
            ? `${lines.length - offset - visibleHeight} more lines below`
            : 'end of file'}
        </Text>
      )}
    </Box>
  );
}
