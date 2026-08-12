import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { sanitizeTerminalDisplayText } from '../utils/display-text.js';
import { markdownLayoutGlyphs } from '../lib/glyphs.js';
import { osc8Hyperlink, terminalSupportsHyperlinks } from '../lib/terminal/hyperlinks.js';
import { parseMarkdownBlocks } from '../utils/markdown/block-parser.js';
import { layoutMarkdown } from '../utils/markdown/layout.js';
import { resolveMarkdownLinkTarget } from '../utils/path-links.js';
import { assertNever } from '../utils/type-guards.js';
import type {
  MarkdownHeadingDepth,
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
} from '../utils/markdown/types.js';
import type { ScrollableDocumentRow } from './scrollable-document.js';
import type { Theme } from './theme.js';

export interface MarkdownSegmentStyle {
  color: string;
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

export interface RenderMarkdownRowsOptions {
  source: string;
  width: number;
  theme: Theme;
  decorateSegment?: MarkdownSegmentDecorator | undefined;
  projectDir?: string | undefined;
}

export function renderMarkdownRows(options: RenderMarkdownRowsOptions): ScrollableDocumentRow[] {
  const { source, width, theme, decorateSegment, projectDir } = options;
  const safeSource = sanitizeTerminalDisplayText(source, { preserveLineBreaks: true });
  const layout = layoutMarkdown(parseMarkdownBlocks(safeSource), {
    width,
    glyphs: markdownLayoutGlyphs(),
  });
  return layout.rows.map((row) => ({
    key: row.key,
    lines: row.height,
    node: renderMarkdownLayoutRow({
      row,
      theme,
      decorateSegment,
      projectDir,
      width: layout.width,
    }),
  }));
}

function renderMarkdownLayoutRow(input: {
  row: MarkdownLayoutRow;
  theme: Theme;
  decorateSegment: MarkdownSegmentDecorator | undefined;
  projectDir: string | undefined;
  width: number;
}): ReactNode {
  const { row, theme, decorateSegment, projectDir, width } = input;
  return (
    <Box flexDirection="column">
      {row.lines.map((line, index) =>
        renderMarkdownLayoutLine({
          line,
          previousLine: row.lines[index - 1],
          key: `${row.key}-${index}`,
          theme,
          decorateSegment,
          projectDir,
          codeWidth: row.blockKind === 'code' ? width : undefined,
        }),
      )}
    </Box>
  );
}

function renderMarkdownLayoutLine(input: {
  line: MarkdownLayoutLine;
  previousLine: MarkdownLayoutLine | undefined;
  key: string;
  theme: Theme;
  decorateSegment: MarkdownSegmentDecorator | undefined;
  projectDir: string | undefined;
  codeWidth: number | undefined;
}): ReactNode {
  const { line, previousLine, key, theme, decorateSegment, projectDir, codeWidth } = input;
  const previousLineText = previousLine?.segments.map((segment) => segment.text).join('');
  const contentIndex = firstContentSegmentIndex(line.segments);
  const content =
    line.segments.length === 0
      ? ' '
      : line.segments.map((segment, index) =>
          renderSegment({
            segment,
            key: `${key}-${index}`,
            theme,
            decorateSegment,
            projectDir,
            previousLineText: index === contentIndex ? previousLineText : undefined,
          }),
        );

  // The ground stops at the block: a blank line inside a code row is the air separating it from
  // the block before it, and painting that would join the two into one long ground.
  const painted =
    codeWidth !== undefined && line.segments.some((segment) => segment.text.trim().length > 0);
  if (!painted || codeWidth === undefined) return <Text key={key}>{content}</Text>;

  const background = theme.markdown.codeBg;
  return (
    <Box
      key={key}
      width={codeWidth}
      {...(background === undefined ? {} : { backgroundColor: background })}
    >
      <Text>{content}</Text>
    </Box>
  );
}

function renderSegment(input: {
  segment: MarkdownLayoutSegment;
  key: string;
  theme: Theme;
  decorateSegment: MarkdownSegmentDecorator | undefined;
  projectDir: string | undefined;
  previousLineText: string | undefined;
}): ReactNode {
  const { segment, key, theme, decorateSegment, projectDir, previousLineText } = input;
  const baseStyle = markdownSegmentStyle(segment, theme);
  const parts = decorateSegment?.({ segment, theme, projectDir, previousLineText }) ?? [
    { text: segment.text },
  ];

  return parts.map((part, index) =>
    renderTextSegment({
      key: `${key}-${index}`,
      text: part.text,
      style: mergeSegmentStyle(baseStyle, part.style),
      href: part.href ?? segment.href,
      projectDir,
    }),
  );
}

function mergeSegmentStyle(
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

function renderTextSegment(input: {
  key: string;
  text: string;
  style: MarkdownSegmentStyle;
  href: string | undefined;
  projectDir: string | undefined;
}): ReactNode {
  const { key, text, style, href, projectDir } = input;
  const cleanText = sanitizeTerminalDisplayText(text);
  const { label, href: resolvedHref } = resolveMarkdownLinkTarget({
    label: cleanText,
    href,
    rootDir: projectDir,
  });
  const content =
    resolvedHref !== undefined && terminalSupportsHyperlinks()
      ? osc8Hyperlink({ label, href: resolvedHref })
      : label;
  return (
    <Text
      key={key}
      color={style.color}
      bold={style.bold === true}
      italic={style.italic === true}
      strikethrough={style.strikethrough === true}
      underline={style.underline === true}
    >
      {content}
    </Text>
  );
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
