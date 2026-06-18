import type { MarkdownInlineToken } from './types.js';

interface EmphasisMatch {
  kind: 'bold' | 'italic' | 'boldItalic';
  delimiter: string;
  start: number;
  end: number;
}

export function parseMarkdownInlines(text: string): MarkdownInlineToken[] {
  const tokens: MarkdownInlineToken[] = [];
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf('`', index);
    if (open === -1) {
      tokens.push(...parseStyledText(text.slice(index)));
      break;
    }

    if (open > index) {
      tokens.push(...parseStyledText(text.slice(index, open)));
    }

    const close = text.indexOf('`', open + 1);
    if (close === -1) {
      tokens.push(...parseStyledText(text.slice(open)));
      break;
    }

    tokens.push({ kind: 'code', text: text.slice(open + 1, close) });
    index = close + 1;
  }

  return tokens;
}

function parseStyledText(text: string): MarkdownInlineToken[] {
  const tokens: MarkdownInlineToken[] = [];
  let index = 0;

  while (index < text.length) {
    const match = findNextEmphasis(text, index);
    if (!match) {
      tokens.push(...tokenizePlainText(text.slice(index)));
      break;
    }

    if (match.start > index) {
      tokens.push(...tokenizePlainText(text.slice(index, match.start)));
    }

    const inner = text.slice(match.start + match.delimiter.length, match.end);
    tokens.push({ kind: match.kind, text: inner });
    index = match.end + match.delimiter.length;
  }

  return tokens;
}

function findNextEmphasis(text: string, fromIndex: number): EmphasisMatch | undefined {
  const candidates: readonly { delimiter: string; kind: EmphasisMatch['kind'] }[] = [
    { delimiter: '***', kind: 'boldItalic' },
    { delimiter: '**', kind: 'bold' },
    { delimiter: '*', kind: 'italic' },
  ];
  let best: EmphasisMatch | undefined;

  for (const candidate of candidates) {
    const start = text.indexOf(candidate.delimiter, fromIndex);
    if (start === -1) continue;

    const end = text.indexOf(candidate.delimiter, start + candidate.delimiter.length);
    if (end === -1) continue;

    if (
      !best ||
      start < best.start ||
      (start === best.start && candidate.delimiter.length > best.delimiter.length)
    ) {
      best = {
        kind: candidate.kind,
        delimiter: candidate.delimiter,
        start,
        end,
      };
    }
  }

  return best;
}

function tokenizePlainText(text: string): MarkdownInlineToken[] {
  return text.length > 0 ? [{ kind: 'text', text }] : [];
}
