import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import { useTheme } from './theme.js';
import { useAsyncHighlight } from './use-async-highlight.js';

type CodeBlock = { type: 'code'; lang: string; code: string };
type TextBlock = { type: 'text'; lines: string[] };
type Block = CodeBlock | TextBlock;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let currentText: string[] = [];
  let inCode = false;
  let codeLang = 'typescript';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (!inCode && line.startsWith('```')) {
      if (currentText.length > 0) {
        blocks.push({ type: 'text', lines: currentText });
        currentText = [];
      }
      const langHint = line.slice(3).trim().toLowerCase();
      codeLang = langHint || 'typescript';
      inCode = true;
      codeLines = [];
    } else if (inCode && line.startsWith('```')) {
      blocks.push({ type: 'code', lang: codeLang, code: codeLines.join('\n') });
      inCode = false;
      codeLines = [];
    } else if (inCode) {
      codeLines.push(line);
    } else {
      currentText.push(line);
    }
  }
  if (inCode && codeLines.length > 0) {
    blocks.push({ type: 'code', lang: codeLang, code: codeLines.join('\n') });
  }
  if (currentText.length > 0) {
    blocks.push({ type: 'text', lines: currentText });
  }
  return blocks;
}

function renderInlineItalic(segment: string, baseKey: string, t: Theme) {
  const parts = segment.split(/\*([^*]+)\*/g);
  if (parts.length === 1) return <Text key={baseKey}>{segment}</Text>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <Text key={`${baseKey}-${i}`} italic color={t.markdown.italic}>{part}</Text>
          : <Text key={`${baseKey}-${i}`}>{part}</Text>
      )}
    </>
  );
}

export function renderMarkdownLine(line: string, key: number, t: Theme) {
  if (line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### ')) {
    const text = line.replace(/^#+\s*/, '');
    return <Text key={key} color={t.markdown.heading} bold>{text}</Text>;
  }
  const boldParts = line.split(/\*\*([^*]+)\*\*/g);
  if (boldParts.length === 1) {
    return <Text key={key} color={t.text}>{renderInlineItalic(line, `${key}-i`, t)}</Text>;
  }
  return (
    <Text key={key} color={t.text}>
      {boldParts.map((part, i) =>
        i % 2 === 1
          ? <Text key={i} color={t.markdown.bold} bold>{part}</Text>
          : renderInlineItalic(part, `${key}-${i}`, t)
      )}
    </Text>
  );
}

function HighlightedCode({ code, lang, theme: t }: { code: string; lang: string; theme: Theme }) {
  const hl = useAsyncHighlight(code, lang);
  const bgProp = t.panelBg ? { backgroundColor: t.panelBg } : {};
  const colorProp = hl ? {} : { color: t.markdown.code };
  return (
    <Box marginY={0} paddingX={1} flexDirection="column">
      <Text {...bgProp} {...colorProp}>{hl ?? code}</Text>
    </Box>
  );
}

export function MarkdownBlock({ text }: { text: string }) {
  const t = useTheme();
  const blocks = parseBlocks(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <HighlightedCode key={i} code={block.code} lang={block.lang} theme={t} />;
        }
        return (
          <Box key={i} flexDirection="column">
            {block.lines.map((line, j) => renderMarkdownLine(line, j, t))}
          </Box>
        );
      })}
    </Box>
  );
}
