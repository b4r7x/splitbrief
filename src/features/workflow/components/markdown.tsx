import { Box } from 'ink';
import type { ReactNode } from 'react';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document/window.js';
import { ThemeText as Text } from '../../../components/theme.js';
import type { Theme } from '../../../core/theme/palette.js';
import { markdownLayoutGlyphs } from '../../../lib/glyphs.js';
import { terminalSupportsHyperlinks, osc8Hyperlink } from '../../../lib/terminal/hyperlinks.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { parseMarkdownBlocks } from '../../../utils/markdown/block-parser.js';
import { layoutMarkdown } from '../../../utils/markdown/layout/document.js';
import type {
  MarkdownLayoutRow,
  MarkdownLayoutLine,
  MarkdownLayoutSegment,
} from '../../../utils/markdown/types.js';
import { resolveMarkdownLinkTarget } from '../../../utils/path/links.js';
import {
  type MarkdownSegmentDecorator,
  firstContentSegmentIndex,
  markdownSegmentStyle,
  mergeSegmentStyle,
  type MarkdownSegmentStyle,
} from './markdown-style.js';

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
