import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { sanitizeTerminalDisplayText } from '../utils/display-text.js';
import { parseMarkdownBlocks } from '../utils/markdown/block-parser.js';
import { layoutMarkdown } from '../utils/markdown/layout.js';
import { assertNever } from '../utils/type-guards.js';
import type {
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
} from '../utils/markdown/types.js';
import type { ScrollableDocumentRow } from './scrollable-document.js';
import type { Theme } from './theme.js';

interface SegmentStyle {
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export interface MarkdownRenderSegmentStyle {
  color?: string | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
}

export interface MarkdownRenderSegment {
  text: string;
  style?: MarkdownRenderSegmentStyle;
}

export type MarkdownSegmentDecorator = (input: {
  segment: MarkdownLayoutSegment;
  theme: Theme;
}) => readonly MarkdownRenderSegment[];

export interface RenderMarkdownRowsOptions {
  source: string;
  width: number;
  theme: Theme;
  decorateSegment?: MarkdownSegmentDecorator | undefined;
}

export function renderMarkdownRows(options: RenderMarkdownRowsOptions): ScrollableDocumentRow[] {
  const { source, width, theme, decorateSegment } = options;
  const safeSource = sanitizeTerminalDisplayText(source, { preserveLineBreaks: true });
  const layout = layoutMarkdown(parseMarkdownBlocks(safeSource), { width });
  return layout.rows.map((row) => ({
    key: row.key,
    lines: row.height,
    node: renderMarkdownLayoutRow({ row, theme, decorateSegment }),
  }));
}

function renderMarkdownLayoutRow(input: {
  row: MarkdownLayoutRow;
  theme: Theme;
  decorateSegment: MarkdownSegmentDecorator | undefined;
}): ReactNode {
  const { row, theme, decorateSegment } = input;
  return (
    <Box flexDirection="column">
      {row.lines.map((line, index) =>
        renderMarkdownLayoutLine({
          line,
          key: `${row.key}-${index}`,
          theme,
          decorateSegment,
        }),
      )}
    </Box>
  );
}

function renderMarkdownLayoutLine(input: {
  line: MarkdownLayoutLine;
  key: string;
  theme: Theme;
  decorateSegment: MarkdownSegmentDecorator | undefined;
}): ReactNode {
  const { line, key, theme, decorateSegment } = input;
  return (
    <Text key={key}>
      {line.segments.map((segment, index) =>
        renderSegment({
          segment,
          key: `${key}-${index}`,
          theme,
          decorateSegment,
        }),
      )}
    </Text>
  );
}

function renderSegment(input: {
  segment: MarkdownLayoutSegment;
  key: string;
  theme: Theme;
  decorateSegment: MarkdownSegmentDecorator | undefined;
}): ReactNode {
  const { segment, key, theme, decorateSegment } = input;
  const baseStyle = segmentStyle(segment, theme);
  const parts = decorateSegment?.({ segment, theme }) ?? [{ text: segment.text }];

  return parts.map((part, index) =>
    renderTextSegment({
      key: `${key}-${index}`,
      text: part.text,
      style: mergeSegmentStyle(baseStyle, part.style),
    }),
  );
}

function mergeSegmentStyle(
  baseStyle: SegmentStyle,
  override: MarkdownRenderSegmentStyle | undefined,
): SegmentStyle {
  if (!override) return baseStyle;
  const style: SegmentStyle = { color: override.color ?? baseStyle.color };
  const bold = override.bold ?? baseStyle.bold;
  const italic = override.italic ?? baseStyle.italic;
  if (bold !== undefined) style.bold = bold;
  if (italic !== undefined) style.italic = italic;
  return style;
}

function renderTextSegment(input: { key: string; text: string; style: SegmentStyle }): ReactNode {
  const { key, text, style } = input;
  const cleanText = sanitizeTerminalDisplayText(text);
  if (style.bold && style.italic) {
    return (
      <Text key={key} color={style.color} bold italic>
        {cleanText}
      </Text>
    );
  }
  if (style.bold) {
    return (
      <Text key={key} color={style.color} bold>
        {cleanText}
      </Text>
    );
  }
  if (style.italic) {
    return (
      <Text key={key} color={style.color} italic>
        {cleanText}
      </Text>
    );
  }
  return (
    <Text key={key} color={style.color}>
      {cleanText}
    </Text>
  );
}

function segmentStyle(segment: MarkdownLayoutSegment, theme: Theme): SegmentStyle {
  switch (segment.kind) {
    case 'heading':
      return { color: theme.markdown.heading, bold: true };
    case 'metadata':
      return { color: theme.textDim };
    case 'rule':
      return { color: theme.markdown.rule };
    case 'listMarker':
      return { color: theme.markdown.list };
    case 'blockquoteMarker':
      return { color: theme.markdown.blockquote };
    case 'code':
      return { color: theme.markdown.code };
    case 'bold':
      return { color: theme.markdown.bold, bold: true };
    case 'italic':
      return { color: theme.markdown.italic, italic: true };
    case 'boldItalic':
      return { color: theme.markdown.bold, bold: true, italic: true };
    case 'text':
      return { color: theme.text };
    default:
      return assertNever(segment.kind);
  }
}
