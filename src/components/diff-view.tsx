import { Box, Text } from 'ink';
import { useAsyncHighlight } from '../hooks/use-async-highlight.js';
import { useTheme, type Theme } from './theme.js';

export interface DiffViewProps {
  file: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  expanded: boolean;
  maxLines: number;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
};

function langFromFile(file: string): string {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return 'typescript';
  const ext = file.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'typescript';
}

function stripPrefix(line: string): string {
  if (line.startsWith('+ ') || line.startsWith('- ')) return line.slice(2);
  if (line.startsWith('  ')) return line.slice(2);
  return line;
}

function diffBg(isAdded: boolean, isRemoved: boolean, diff: { addedBg: string | undefined; removedBg: string | undefined; contextBg: string | undefined }): string | undefined {
  if (isAdded) return diff.addedBg;
  if (isRemoved) return diff.removedBg;
  return diff.contextBg;
}

function diffColor(isAdded: boolean, isRemoved: boolean, diff: Theme['diff']): string {
  if (isAdded) return diff.added;
  if (isRemoved) return diff.removed;
  return diff.context;
}

interface DiffLineProps {
  line: string;
  lineNum: string;
  highlightedContent: string | null;
  theme: Theme;
}

function DiffLine({ line, lineNum, highlightedContent, theme: t }: DiffLineProps) {
  const isAdded = line.startsWith('+ ');
  const isRemoved = line.startsWith('- ');
  const stripped = stripPrefix(line);
  const bg = diffBg(isAdded, isRemoved, t.diff);
  const fallbackColor = diffColor(isAdded, isRemoved, t.diff);
  const content = (isAdded || isRemoved) && highlightedContent ? highlightedContent : stripped;
  const hasHighlight = !!(isAdded || isRemoved) && highlightedContent;
  const colorProp = hasHighlight ? {} : { color: fallbackColor };
  const bgProp = bg !== undefined ? { backgroundColor: bg } : {};
  return (
    <Box>
      <Text color={t.border}>{lineNum} </Text>
      <Text {...colorProp} {...bgProp}>{content}</Text>
    </Box>
  );
}

export function DiffView({ file, linesAdded, linesRemoved, diff, expanded, maxLines }: DiffViewProps) {
  const t = useTheme();

  const lines = diff ? diff.split('\n').filter(l => l.length > 0) : [];
  const visible = lines.slice(0, maxLines);
  const lang = langFromFile(file);

  const codeToHighlight = (!expanded || visible.length === 0)
    ? ''
    : visible
      .filter(l => l.startsWith('+ ') || l.startsWith('- '))
      .map(stripPrefix)
      .join('\n');

  const highlighted = useAsyncHighlight(codeToHighlight, lang);

  const highlightedLines = highlighted ? highlighted.split('\n') : null;

  if (!expanded || lines.length === 0) {
    return (
      <Box>
        <Text color={t.textDim}>  ▸ {file} (+{linesAdded} -{linesRemoved})</Text>
        <Text color={t.accent}>  Ctrl+D</Text>
      </Box>
    );
  }

  const remaining = lines.length - visible.length;
  let highlightIdx = 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.textDim}>  ▾ {file} (+{linesAdded} -{linesRemoved})</Text>
        <Text color={t.accent}>  Ctrl+D</Text>
      </Box>
      <Box flexDirection="column" marginLeft={4}>
        {visible.map((line, i) => {
          const needsHighlight = line.startsWith('+ ') || line.startsWith('- ');
          const highlightedContent = needsHighlight && highlightedLines
            ? highlightedLines[highlightIdx++] ?? null
            : null;
          return (
            <DiffLine
              key={i}
              line={line}
              lineNum={String(i + 1).padStart(3, ' ')}
              highlightedContent={highlightedContent}
              theme={t}
            />
          );
        })}
        {remaining > 0 && <Text color={t.textDim}>    ...{remaining} more lines</Text>}
      </Box>
    </Box>
  );
}
