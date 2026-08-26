import {
  getTerminalCellWidth,
  splitTerminalGraphemes,
  wrapTerminalGraphemes,
} from '../display-text.js';
import { assertNever } from '../type-guards.js';
import type { MarkdownInlineToken, MarkdownLayoutLine, MarkdownLayoutSegment } from './types.js';

type WrapMode = 'word' | 'hard';

export function appendSegment(
  target: MarkdownLayoutSegment[],
  segment: MarkdownLayoutSegment,
): void {
  if (segment.text.length === 0) return;
  const last = target[target.length - 1];
  if (last?.kind === segment.kind && last.href === segment.href && last.scope === segment.scope) {
    target[target.length - 1] = { ...last, text: `${last.text}${segment.text}` };
    return;
  }
  target.push({ ...segment });
}

export function inlineTokenToSegment(token: MarkdownInlineToken): MarkdownLayoutSegment {
  switch (token.kind) {
    case 'text':
      return { kind: 'text', text: token.text };
    case 'code':
      return { kind: 'code', text: token.text };
    case 'bold':
      return { kind: 'bold', text: token.text };
    case 'italic':
      return { kind: 'italic', text: token.text };
    case 'boldItalic':
      return { kind: 'boldItalic', text: token.text };
    case 'strikethrough':
      return { kind: 'strikethrough', text: token.text };
    case 'link':
      return { kind: 'link', text: token.text, href: token.href };
    default:
      return assertNever(token);
  }
}

export function trimTrailingSpace(
  segments: readonly MarkdownLayoutSegment[],
): MarkdownLayoutSegment[] {
  const trimmed = [...segments];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last === undefined) break;
    const text = last.text.replace(/\s+$/, '');
    if (text.length > 0) {
      trimmed[trimmed.length - 1] = { ...last, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

export function measureSegments(segments: readonly MarkdownLayoutSegment[]): number {
  return segments.reduce((sum, segment) => sum + getTerminalCellWidth(segment.text), 0);
}

export function wrapSegments(input: {
  segments: readonly MarkdownLayoutSegment[];
  firstPrefix: readonly MarkdownLayoutSegment[];
  continuationPrefix: readonly MarkdownLayoutSegment[];
  width: number;
  mode: WrapMode;
}): MarkdownLayoutLine[] {
  const { segments, firstPrefix, continuationPrefix, width, mode } = input;
  const wrapWidth = Math.max(1, width);
  let maxContentGraphemeWidth = 1;
  for (const segment of segments) {
    for (const grapheme of splitTerminalGraphemes(segment.text)) {
      maxContentGraphemeWidth = Math.max(maxContentGraphemeWidth, getTerminalCellWidth(grapheme));
    }
  }
  const prefixBudget = Math.max(0, wrapWidth - maxContentGraphemeWidth);
  const fittedFirstPrefix = fitPrefixSegments(firstPrefix, prefixBudget);
  const fittedContinuationPrefix = fitPrefixSegments(continuationPrefix, prefixBudget);
  const lines: MarkdownLayoutLine[] = [];
  let current = cloneSegments(fittedFirstPrefix);
  let currentLength = measureSegments(current);
  let prefixLength = currentLength;

  const startContinuation = () => {
    lines.push({ segments: trimTrailingSpace(current) });
    current = cloneSegments(fittedContinuationPrefix);
    currentLength = measureSegments(current);
    prefixLength = currentLength;
  };

  const appendPart = (segment: MarkdownLayoutSegment, text: string) => {
    appendSegment(current, { ...segment, text });
    currentLength += getTerminalCellWidth(text);
  };

  const appendHard = (segment: MarkdownLayoutSegment, text: string) => {
    wrapTerminalGraphemes({
      graphemes: splitTerminalGraphemes(text),
      maxWidth: wrapWidth,
      initialWidth: currentLength,
      flush: () => {
        startContinuation();
        return currentLength;
      },
      append: (grapheme) => appendPart(segment, grapheme),
    });
  };

  const appendWord = (segment: MarkdownLayoutSegment, text: string) => {
    const textWidth = getTerminalCellWidth(text);
    if (/^\s+$/.test(text)) {
      if (currentLength === prefixLength) return;
      if (currentLength + textWidth <= wrapWidth) {
        appendPart(segment, text);
      } else {
        startContinuation();
      }
      return;
    }

    if (textWidth > wrapWidth - prefixLength) {
      if (currentLength > prefixLength) startContinuation();
      appendHard(segment, text);
      return;
    }

    if (currentLength + textWidth > wrapWidth) {
      startContinuation();
    }
    appendPart(segment, text);
  };

  for (const segment of segments) {
    if (mode === 'hard') {
      appendHard(segment, segment.text);
      continue;
    }

    for (const part of segment.text.split(/(\s+)/)) {
      appendWord(segment, part);
    }
  }

  lines.push({ segments: trimTrailingSpace(current) });
  return lines;
}

function cloneSegments(segments: readonly MarkdownLayoutSegment[]): MarkdownLayoutSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

function fitPrefixSegments(
  segments: readonly MarkdownLayoutSegment[],
  maxCells: number,
): MarkdownLayoutSegment[] {
  if (maxCells <= 0) return [];
  const fitted: MarkdownLayoutSegment[] = [];
  let remaining = maxCells;

  for (const segment of segments) {
    const graphemes: string[] = [];
    for (const grapheme of splitTerminalGraphemes(segment.text)) {
      const graphemeWidth = getTerminalCellWidth(grapheme);
      if (graphemeWidth > remaining) {
        appendSegment(fitted, { ...segment, text: graphemes.join('') });
        return fitted;
      }
      graphemes.push(grapheme);
      remaining -= graphemeWidth;
      if (remaining === 0) {
        appendSegment(fitted, { ...segment, text: graphemes.join('') });
        return fitted;
      }
    }
    appendSegment(fitted, { ...segment, text: graphemes.join('') });
  }

  return fitted;
}
