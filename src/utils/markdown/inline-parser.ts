import type { MarkdownInlineToken } from './types.js';

interface EmphasisMatch {
  kind: 'bold' | 'italic' | 'boldItalic' | 'strikethrough';
  delimiter: string;
  start: number;
  end: number;
}

interface LinkMatch {
  start: number;
  end: number;
  label: string;
  href: string;
  image: boolean;
}

export function parseMarkdownInlines(text: string): MarkdownInlineToken[] {
  const tokens: MarkdownInlineToken[] = [];
  let index = 0;
  let styledFrom = 0;

  const flushStyled = (end: number) => {
    if (end > styledFrom) tokens.push(...parseStyledText(text.slice(styledFrom, end)));
  };

  while (index < text.length) {
    const codeOpen = text.indexOf('`', index);
    const commentOpen = text.indexOf('<!--', index);
    if (codeOpen === -1 && commentOpen === -1) break;

    if (commentOpen !== -1 && (codeOpen === -1 || commentOpen < codeOpen)) {
      flushStyled(commentOpen);
      const commentClose = text.indexOf('-->', commentOpen + 4);
      // An unterminated comment hides the rest of the block text so a streamed
      // marker tail never flashes as prose.
      if (commentClose === -1) return tokens;
      index = commentClose + 3;
      styledFrom = index;
      continue;
    }

    const codeClose = text.indexOf('`', codeOpen + 1);
    if (codeClose === -1) {
      flushStyled(codeOpen);
      styledFrom = codeOpen;
      index = codeOpen + 1;
      continue;
    }

    const link = findNextLink(text, index);
    if (link && link.start <= codeOpen && link.end > codeOpen) {
      // A complete link spanning the backtick outranks the code span; flushing
      // through its end lets the styled pass emit it with backticks literal.
      flushStyled(link.end);
      index = link.end;
      styledFrom = index;
      continue;
    }

    flushStyled(codeOpen);
    tokens.push({ kind: 'code', text: text.slice(codeOpen + 1, codeClose) });
    index = codeClose + 1;
    styledFrom = index;
  }

  flushStyled(text.length);
  return tokens;
}

function parseStyledText(text: string): MarkdownInlineToken[] {
  const tokens: MarkdownInlineToken[] = [];
  let index = 0;

  while (index < text.length) {
    const link = findNextLink(text, index);
    if (!link) {
      tokens.push(...parseEmphasisText(text.slice(index)));
      break;
    }

    if (link.start > index) {
      tokens.push(...parseEmphasisText(text.slice(index, link.start)));
    }

    if (link.image) {
      tokens.push(...tokenizePlainText(link.label));
    } else {
      tokens.push({ kind: 'link', text: link.label, href: link.href });
    }
    index = link.end;
  }

  return tokens;
}

function findNextLink(text: string, fromIndex: number): LinkMatch | undefined {
  let index = fromIndex;

  while (index < text.length) {
    const open = text.indexOf('[', index);
    if (open === -1) return undefined;

    const close = text.indexOf(']', open + 1);
    if (close === -1) return undefined;

    const nested = text.indexOf('[', open + 1);
    if (nested !== -1 && nested < close) {
      index = nested;
      continue;
    }

    if (text[close + 1] !== '(') {
      index = close + 1;
      continue;
    }

    const targetClose = findTargetClose(text, close + 2);
    if (targetClose === -1) {
      index = close + 1;
      continue;
    }

    const image = open > 0 && text[open - 1] === '!';
    return {
      start: image ? open - 1 : open,
      end: targetClose + 1,
      label: text.slice(open + 1, close),
      href: text.slice(close + 2, targetClose).trim(),
      image,
    };
  }

  return undefined;
}

function findTargetClose(text: string, targetStart: number): number {
  let depth = 1;
  for (let index = targetStart; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  // Text may end mid-target while streaming; the first ')' keeps the
  // pre-balance close so a partially streamed link still resolves.
  return text.indexOf(')', targetStart);
}

function parseEmphasisText(text: string): MarkdownInlineToken[] {
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
    { delimiter: '~~', kind: 'strikethrough' },
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
