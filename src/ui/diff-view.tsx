import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { highlight } from '../utils/highlight.js';
import { useTheme } from './theme.js';

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

function diffBg(isAdded: boolean, isRemoved: boolean, diff: { addedBg: string; removedBg: string; contextBg: string }): string {
  if (isAdded) return diff.addedBg;
  if (isRemoved) return diff.removedBg;
  return diff.contextBg;
}

export default function DiffView({ file, linesAdded, linesRemoved, diff, expanded }: DiffViewProps) {
  const t = useTheme();
  const [highlighted, setHighlighted] = useState<Map<number, string>>(new Map());

  const lines = diff ? diff.split('\n').filter(l => l.length > 0) : [];
  const visible = lines.slice(0, MAX_LINES);
  useEffect(() => {
    if (!expanded) return;
    if (visible.length === 0) {
      setHighlighted(new Map());
      return;
    }

    setHighlighted(new Map());

    let cancelled = false;
    const run = async () => {
      const results = new Map<number, string>();
      for (let i = 0; i < visible.length; i++) {
        const line = visible[i];
        if (line.startsWith('+ ') || line.startsWith('- ')) {
          const hl = await highlight(stripPrefix(line));
          if (cancelled) return;
          results.set(i, hl.replace(/\n$/, ''));
        }
      }
      if (!cancelled) setHighlighted(results);
    };
    run();
    return () => { cancelled = true; };
  }, [expanded, diff]);

  if (!expanded || lines.length === 0) {
    return (
      <Box>
        <Text color={t.textDim}>  ▸ {file} (+{linesAdded} -{linesRemoved})</Text>
        <Text color={t.accent}>  Ctrl+D</Text>
      </Box>
    );
  }

  const remaining = lines.length - visible.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.textDim}>  ▾ {file} (+{linesAdded} -{linesRemoved})</Text>
        <Text color={t.accent}>  Ctrl+D</Text>
      </Box>
      <Box flexDirection="column" marginLeft={4}>
        {visible.map((line, i) => {
          const lineNum = String(i + 1).padStart(3, ' ');
          const isAdded = line.startsWith('+ ');
          const isRemoved = line.startsWith('- ');
          const bg = diffBg(isAdded, isRemoved, t.diff);
          const color = (!isAdded && !isRemoved) ? t.diff.context : undefined;
          const content = (isAdded || isRemoved) ? (highlighted.get(i) ?? stripPrefix(line)) : stripPrefix(line);
          return (
            <Box key={`${i}-${line.slice(0, 30)}`}>
              <Text color={t.border}>{lineNum} </Text>
              <Text color={color} backgroundColor={bg}>{content}</Text>
            </Box>
          );
        })}
        {remaining > 0 && <Text color={t.textDim}>    ...{remaining} more lines</Text>}
      </Box>
    </Box>
  );
}
