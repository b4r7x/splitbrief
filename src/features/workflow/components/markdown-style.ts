import type { Theme } from '../../../core/theme/palette.js';
import type { MarkdownHeadingDepth, MarkdownLayoutSegment } from '../../../utils/markdown/types.js';
import { assertNever } from '../../../utils/type-guards.js';

export interface MarkdownSegmentStyle {
  color: string | undefined;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

export interface MarkdownRenderSegmentStyle {
  color?: string | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  strikethrough?: boolean | undefined;
  underline?: boolean | undefined;
}

export interface MarkdownRenderSegment {
  text: string;
  style?: MarkdownRenderSegmentStyle;
  href?: string | undefined;
}

export type MarkdownSegmentDecorator = (input: {
  segment: MarkdownLayoutSegment;
  theme: Theme;
  projectDir: string | undefined;
  // Set only for a line's first content segment (leading blockquote/list markers and
  // whitespace-only indents skipped) when the line continues a wrapped logical row, so
  // decorators can tell wrap-start matches apart from hard-wrapped word fragments.
  previousLineText?: string | undefined;
}) => readonly MarkdownRenderSegment[];

export function firstContentSegmentIndex(segments: readonly MarkdownLayoutSegment[]): number {
  return segments.findIndex(
    (segment) =>
      segment.kind !== 'blockquoteMarker' &&
      segment.kind !== 'listMarker' &&
      !(segment.kind === 'text' && segment.text.trim() === ''),
  );
}

export function mergeSegmentStyle(
  baseStyle: MarkdownSegmentStyle,
  override: MarkdownRenderSegmentStyle | undefined,
): MarkdownSegmentStyle {
  if (!override) return baseStyle;
  const style: MarkdownSegmentStyle = { color: override.color ?? baseStyle.color };
  const bold = override.bold ?? baseStyle.bold;
  const italic = override.italic ?? baseStyle.italic;
  const strikethrough = override.strikethrough ?? baseStyle.strikethrough;
  const underline = override.underline ?? baseStyle.underline;
  if (bold !== undefined) style.bold = bold;
  if (italic !== undefined) style.italic = italic;
  if (strikethrough !== undefined) style.strikethrough = strikethrough;
  if (underline !== undefined) style.underline = underline;
  return style;
}

// Six ranks that step down without spending a hue: brightness first, then weight, then slant,
// with depth 1 taking the hairline that layout puts under it. Every rank differs from body text —
// markdown.heading is a step brighter than text, and the two ranks that fall back to body
// brightness carry weight instead. Underline is left out on purpose: that is how a link
// identifies itself.
function headingStyle(depth: MarkdownHeadingDepth, theme: Theme): MarkdownSegmentStyle {
  switch (depth) {
    case 1:
    case 2:
      return { color: theme.markdown.heading, bold: true };
    case 3:
      return { color: theme.markdown.heading };
    case 4:
      return { color: theme.text, bold: true };
    case 5:
      return { color: theme.textDim, bold: true };
    case 6:
      return { color: theme.textDim, italic: true };
    default:
      return assertNever(depth);
  }
}

export function markdownSegmentStyle(
  segment: MarkdownLayoutSegment,
  theme: Theme,
): MarkdownSegmentStyle {
  switch (segment.kind) {
    case 'heading':
      return headingStyle(segment.depth ?? 1, theme);
    case 'metadata':
      return { color: theme.textDim };
    case 'codeLanguage':
      return { color: theme.markdown.codeGutter };
    case 'rule':
      return { color: theme.markdown.rule };
    case 'listMarker':
      return { color: theme.markdown.list };
    case 'blockquoteMarker':
      return { color: theme.markdown.blockquote };
    case 'codeGutter':
      return { color: theme.markdown.codeGutter };
    case 'codeText':
      return { color: theme.text };
    case 'code':
      return segment.scope !== undefined
        ? { color: theme.syntax[segment.scope] }
        : { color: theme.markdown.code };
    case 'bold':
      return { color: theme.markdown.bold, bold: true };
    case 'italic':
      return { color: theme.markdown.italic, italic: true };
    case 'boldItalic':
      return { color: theme.markdown.bold, bold: true, italic: true };
    case 'strikethrough':
      return { color: theme.markdown.strike, strikethrough: true };
    case 'link':
      return { color: theme.markdown.link, underline: true };
    case 'tableBorder':
      return { color: theme.markdown.tableBorder };
    case 'tableHeader':
      return { color: theme.markdown.heading, bold: true };
    case 'text':
      return { color: theme.text };
    default:
      return assertNever(segment.kind);
  }
}
