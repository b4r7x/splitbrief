import { Text } from 'ink';
import type { Theme } from './theme.js';

function renderInlineItalic(segment: string, baseKey: string, t: Theme) {
  const parts = segment.split(/\*([^*]+)\*/g);
  if (parts.length === 1) return <Text key={baseKey}>{segment}</Text>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={`${baseKey}-${i}`} italic color={t.markdown.italic}>
            {part}
          </Text>
        ) : (
          <Text key={`${baseKey}-${i}`}>{part}</Text>
        ),
      )}
    </>
  );
}

function renderInlineElements(text: string, baseKey: string, t: Theme) {
  const codeParts = text.split(/(`[^`]+`)/g);
  return codeParts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <Text key={`${baseKey}-c${i}`} color={t.markdown.code}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    const boldParts = part.split(/\*\*([^*]+)\*\*/g);
    if (boldParts.length === 1) {
      return renderInlineItalic(part, `${baseKey}-${i}`, t);
    }
    return (
      <Text key={`${baseKey}-b${i}`}>
        {boldParts.map((bPart, j) =>
          j % 2 === 1 ? (
            <Text key={j} color={t.markdown.bold} bold>
              {bPart}
            </Text>
          ) : (
            renderInlineItalic(bPart, `${baseKey}-${i}-${j}`, t)
          ),
        )}
      </Text>
    );
  });
}

export function renderMarkdownLine(line: string, key: number, t: Theme) {
  if (/^#{1,3}\s+/.test(line)) {
    const text = line.replace(/^#+\s*/, '');
    return (
      <Text key={key} color={t.markdown.heading} bold>
        {text}
      </Text>
    );
  }

  if (/^(---|\*\*\*|___)\s*$/.test(line)) {
    return (
      <Text key={key} color={t.markdown.rule}>
        {'─'.repeat(40)}
      </Text>
    );
  }

  if (line.startsWith('> ')) {
    return (
      <Text key={key} color={t.markdown.blockquote}>
        {'  ▎ '}
        {line.slice(2)}
      </Text>
    );
  }

  if (/^(\*|-)\s+/.test(line)) {
    const text = line.replace(/^(\*|-)\s+/, '');
    return (
      <Text key={key} color={t.markdown.list}>
        {'  • '}
        {renderInlineElements(text, `${key}`, t)}
      </Text>
    );
  }

  const orderedListMarker = /^\d+\.\s+/.exec(line)?.[0];
  if (orderedListMarker) {
    const text = line.slice(orderedListMarker.length);
    const num = orderedListMarker.slice(0, orderedListMarker.indexOf('.'));
    return (
      <Text key={key} color={t.markdown.list}>
        {'  '}
        {num}. {renderInlineElements(text, `${key}`, t)}
      </Text>
    );
  }

  return (
    <Text key={key} color={t.text}>
      {renderInlineElements(line, `${key}`, t)}
    </Text>
  );
}
