import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs/promises';
import { useAppContext } from '../app.js';
import { renderMarkdownLine } from './markdown.js';

interface ReviewViewProps {
  filePath: string;
  height?: number;
}

export default function ReviewView({ filePath, height }: ReviewViewProps) {
  const { theme: t } = useAppContext();
  const [content, setContent] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fs.readFile(filePath, 'utf-8').then(data => {
      if (!cancelled) setContent(data);
    }).catch(() => {
      if (!cancelled) setContent('(Error reading file)');
    });
    return () => { cancelled = true; };
  }, [filePath]);

  const lines = content.split('\n');
  const visibleHeight = height ?? 20;
  const maxOffset = Math.max(0, lines.length - visibleHeight);

  useInput((_input, key) => {
    if (key.upArrow) setOffset((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setOffset((prev) => Math.min(maxOffset, prev + 1));
  });

  const visibleLines = lines.slice(offset, offset + visibleHeight);

  return (
    <Box flexDirection="column" height={visibleHeight} overflow="hidden">
      <Text color={t.textDim}>{filePath}</Text>
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
