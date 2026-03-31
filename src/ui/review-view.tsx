import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { readFileSync, existsSync } from 'node:fs';
import type { Theme } from '../theme.js';

interface ReviewViewProps {
  filePath: string;
  theme: Theme;
  height?: number;
  scrollOffset?: number;
}

function renderMarkdownLine(line: string, key: number, t: Theme) {
  if (line.startsWith('# ')) {
    return <Text key={key} color={t.accent} bold>{line.slice(2)}</Text>;
  }
  if (line.startsWith('## ')) {
    return <Text key={key} color={t.accent} bold>{line.slice(3)}</Text>;
  }
  if (line.startsWith('### ')) {
    return <Text key={key} color={t.info}>{line.slice(4)}</Text>;
  }
  if (line.startsWith('- ') || line.startsWith('* ')) {
    return <Text key={key} color={t.text}>  {line}</Text>;
  }
  if (line.startsWith('```')) {
    return <Text key={key} color={t.textDim}>{line}</Text>;
  }

  const boldParts = line.split(/\*\*([^*]+)\*\*/g);
  if (boldParts.length > 1) {
    return (
      <Text key={key} color={t.text}>
        {boldParts.map((part, i) =>
          i % 2 === 1
            ? <Text key={i} bold>{part}</Text>
            : <Text key={i}>{part}</Text>
        )}
      </Text>
    );
  }

  return <Text key={key} color={t.text}>{line}</Text>;
}

export default function ReviewView({ filePath, theme: t, height, scrollOffset: externalOffset }: ReviewViewProps) {
  const [content, setContent] = useState('');
  const [offset, setOffset] = useState(externalOffset ?? 0);

  useEffect(() => {
    if (existsSync(filePath)) {
      setContent(readFileSync(filePath, 'utf-8'));
    } else {
      setContent(`File not found: ${filePath}`);
    }
  }, [filePath]);

  useEffect(() => {
    if (externalOffset != null) setOffset(externalOffset);
  }, [externalOffset]);

  const lines = content.split('\n');
  const visibleHeight = height ?? 20;
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
