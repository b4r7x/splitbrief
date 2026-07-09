import { getTerminalCellWidth } from '../display-text.js';
import { assertNever } from '../type-guards.js';
import type { MarkdownInlineToken, MarkdownLayoutSegment } from './types.js';

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
