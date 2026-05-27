import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import { useTheme } from './theme.js';
import { useAsyncHighlight } from '../hooks/use-async-highlight.js';

type CodeBlock = { type: 'code'; lang: string; label: string; code: string };
type TextBlock = { type: 'text'; lines: string[] };
type Block = CodeBlock | TextBlock;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let currentText: string[] = [];
  let inCode = false;
  let codeLang = 'typescript';
  let codeLabel = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (!inCode && line.startsWith('```')) {
      if (currentText.length > 0) {
        blocks.push({ type: 'text', lines: currentText });
        currentText = [];
      }
      const langHint = line.slice(3).trim().toLowerCase();
      codeLang = langHint || 'typescript';
      codeLabel = langHint;
      inCode = true;
      codeLines = [];
    } else if (inCode && line.startsWith('```')) {
      blocks.push({
        type: 'code',
        lang: codeLang,
        label: codeLabel,
        code: codeLines.join('\n'),
      });
      inCode = false;
      codeLabel = '';
      codeLines = [];
    } else if (inCode) {
      codeLines.push(line);
    } else {
      currentText.push(line);
    }
  }
  if (inCode && codeLines.length > 0) {
    blocks.push({
      type: 'code',
      lang: codeLang,
      label: codeLabel,
      code: codeLines.join('\n'),
    });
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

function renderInlineElements(text: string, baseKey: string, t: Theme) {
  const codeParts = text.split(/(`[^`]+`)/g);
  return codeParts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <Text key={`${baseKey}-c${i}`} color={t.markdown.code}>{part.slice(1, -1)}</Text>;
    }
    const boldParts = part.split(/\*\*([^*]+)\*\*/g);
    if (boldParts.length === 1) {
      return renderInlineItalic(part, `${baseKey}-${i}`, t);
    }
    return (
      <Text key={`${baseKey}-b${i}`}>
        {boldParts.map((bPart, j) =>
          j % 2 === 1
            ? <Text key={j} color={t.markdown.bold} bold>{bPart}</Text>
            : renderInlineItalic(bPart, `${baseKey}-${i}-${j}`, t)
        )}
      </Text>
    );
  });
}

export function renderMarkdownLine(line: string, key: number, t: Theme) {
  if (/^#{1,3}\s+/.test(line)) {
    const text = line.replace(/^#+\s*/, '');
    return <Text key={key} color={t.markdown.heading} bold>{text}</Text>;
  }

  if (/^(---|\*\*\*|___)\s*$/.test(line)) {
    return <Text key={key} color={t.markdown.rule}>{'─'.repeat(40)}</Text>;
  }

  if (line.startsWith('> ')) {
    return (
      <Text key={key} color={t.markdown.blockquote}>
        {'  ▎ '}{line.slice(2)}
      </Text>
    );
  }

  if (/^(\*|-)\s+/.test(line)) {
    const text = line.replace(/^(\*|-)\s+/, '');
    return (
      <Text key={key} color={t.markdown.list}>
        {'  • '}{renderInlineElements(text, `${key}`, t)}
      </Text>
    );
  }

  const orderedListMarker = /^\d+\.\s+/.exec(line)?.[0];
  if (orderedListMarker) {
    const text = line.slice(orderedListMarker.length);
    const num = orderedListMarker.slice(0, orderedListMarker.indexOf('.'));
    return (
      <Text key={key} color={t.markdown.list}>
        {'  '}{num}. {renderInlineElements(text, `${key}`, t)}
      </Text>
    );
  }

  return <Text key={key} color={t.text}>{renderInlineElements(line, `${key}`, t)}</Text>;
}

function HighlightedCode({
  code,
  lang,
  label,
  marginTop,
  theme: t,
}: {
  code: string;
  lang: string;
  label: string;
  marginTop: number;
  theme: Theme;
}) {
  const hl = useAsyncHighlight(code, lang);
  const bgProp = t.panelBg ? { backgroundColor: t.panelBg } : {};
  const lines = (hl ?? code).split('\n');

  return (
    <Box flexDirection="column" marginTop={marginTop} marginBottom={1} {...bgProp}>
      {label ? (
        <Box paddingX={1}>
          <Text color={t.textDim} dimColor>{label}</Text>
        </Box>
      ) : null}
      <Box paddingX={1} flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
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
          return (
            <HighlightedCode
              key={i}
              code={block.code}
              lang={block.lang}
              label={block.label}
              marginTop={i === 0 ? 0 : 1}
              theme={t}
            />
          );
        }
        return (
          <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
            {block.lines.map((line, j) => renderMarkdownLine(line, j, t))}
          </Box>
        );
      })}
    </Box>
  );
}
