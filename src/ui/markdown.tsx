import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../core/theme.js';
import { highlight } from '../utils/highlight.js';

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
          ? <Text key={`${baseKey}-${i}`} italic>{part}</Text>
          : <Text key={`${baseKey}-${i}`}>{part}</Text>
      )}
    </>
  );
}

export function renderMarkdownLine(line: string, key: number, t: Theme) {
  if (line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### ')) {
    const text = line.replace(/^#+\s*/, '');
    return <Text key={key} color={t.accent} bold>{text}</Text>;
  }
  const boldParts = line.split(/\*\*([^*]+)\*\*/g);
  if (boldParts.length > 1) {
    return (
      <Text key={key} color={t.text}>
        {boldParts.map((part, i) =>
          i % 2 === 1
            ? <Text key={i} color={t.warning}>{part}</Text>
            : renderInlineItalic(part, `${key}-${i}`, t)
        )}
      </Text>
    );
  }
  const emParts = line.split(/\*([^*]+)\*/g);
  if (emParts.length > 1) {
    return (
      <Text key={key} color={t.text}>
        {emParts.map((part, i) =>
          i % 2 === 1
            ? <Text key={i} italic>{part}</Text>
            : <Text key={i}>{part}</Text>
        )}
      </Text>
    );
  }
  return <Text key={key} color={t.text}>{line}</Text>;
}

function HighlightedCode({ code, lang, theme: t }: { code: string; lang: string; theme: Theme }) {
  const [hl, setHl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlight(code, lang).then(result => {
      if (!cancelled) setHl(result.replace(/\n$/, ''));
    });
    return () => { cancelled = true; };
  }, [code, lang]);

  return (
    <Box marginY={0} paddingX={1} flexDirection="column">
      <Text backgroundColor={t.panelBg || undefined}>{hl ?? code}</Text>
    </Box>
  );
}

export function PlannerText({ text, theme: t }: { text: string; theme: Theme }) {
  const blocks = parseBlocks(text);

  return (
    <Box marginLeft={2} flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <HighlightedCode key={`code-${i}-${block.lang}-${block.code.slice(0, 40)}`} code={block.code} lang={block.lang} theme={t} />;
        }
        return (
          <Box key={`text-${i}-${block.lines[0]?.slice(0, 30) ?? ''}`} flexDirection="column">
            {block.lines.map((line, j) => renderMarkdownLine(line, j, t))}
          </Box>
        );
      })}
    </Box>
  );
}
