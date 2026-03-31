import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { highlight } from '../engine/highlight.js';
import { getTheme } from '../theme.js';

export interface DiffViewProps {
  file: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  expanded: boolean;
}

const MAX_LINES = 50;

function stripPrefix(line: string): string {
  if (line.startsWith('+ ') || line.startsWith('- ')) return line.slice(2);
  if (line.startsWith('  ')) return line.slice(2);
  return line;
}

export default function DiffView({ file, linesAdded, linesRemoved, diff, expanded }: DiffViewProps) {
  const t = getTheme();
  const [highlighted, setHighlighted] = useState<Map<number, string>>(new Map());

  const lines = diff ? diff.split('\n').filter(l => l.length > 0) : [];
  const visible = lines.slice(0, MAX_LINES);

  useEffect(() => {
    if (!expanded || visible.length === 0) return;

    let cancelled = false;
    const run = async () => {
      const results = new Map<number, string>();
      for (let i = 0; i < visible.length; i++) {
        const line = visible[i];
        if (line.startsWith('+ ') || line.startsWith('- ')) {
          const code = stripPrefix(line);
          const hl = await highlight(code);
          if (cancelled) return;
          results.set(i, hl.replace(/\n$/, ''));
        }
      }
      if (!cancelled) setHighlighted(results);
    };
    run();
    return () => { cancelled = true; };
  }, [expanded, diff]);

  if (!expanded) {
    return (
      <Box>
        <Text color={t.textDim}>  {file} (+{linesAdded} -{linesRemoved})</Text>
      </Box>
    );
  }

  if (lines.length === 0) {
    return (
      <Box>
        <Text color={t.textDim}>  {file} (+{linesAdded} -{linesRemoved})</Text>
      </Box>
    );
  }

  const remaining = lines.length - visible.length;

  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>  {file} (+{linesAdded} -{linesRemoved})</Text>
      <Box flexDirection="column" marginLeft={4}>
        {visible.map((line, i) => {
          const lineNum = String(i + 1).padStart(3, ' ');
          if (line.startsWith('+ ')) {
            const hl = highlighted.get(i);
            return (
              <Box key={i}>
                <Text color={t.border}>{lineNum} </Text>
                <Text backgroundColor={t.diff.addedBg}>{hl ?? stripPrefix(line)}</Text>
              </Box>
            );
          }
          if (line.startsWith('- ')) {
            const hl = highlighted.get(i);
            return (
              <Box key={i}>
                <Text color={t.border}>{lineNum} </Text>
                <Text backgroundColor={t.diff.removedBg}>{hl ?? stripPrefix(line)}</Text>
              </Box>
            );
          }
          return (
            <Box key={i}>
              <Text color={t.border}>{lineNum} </Text>
              <Text color={t.diff.context} backgroundColor={t.diff.contextBg}>{stripPrefix(line)}</Text>
            </Box>
          );
        })}
        {remaining > 0 && <Text color={t.textDim}>    ...{remaining} more lines</Text>}
      </Box>
    </Box>
  );
}
