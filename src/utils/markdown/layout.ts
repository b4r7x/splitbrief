import type {
  MarkdownBlock,
  MarkdownDocument,
  MarkdownHeadingDepth,
  MarkdownInlineToken,
  MarkdownLayout,
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
  MarkdownLayoutGlyphs,
  MarkdownLayoutTail,
  MarkdownListItem,
} from './types.js';
import { getTerminalCellWidth } from '../display-text.js';
import { layoutCodeBlockLines } from './layout-code.js';
import { inlineTokenToSegment, measureSegments, wrapSegments } from './layout-segments.js';
import { layoutMarkdownTable } from './layout-table.js';
import { assertNever } from '../type-guards.js';

interface LayoutOptions {
  width: number;
  glyphs: MarkdownLayoutGlyphs;
  previousBlock?: MarkdownLayoutTail | undefined;
}

export function layoutMarkdown(document: MarkdownDocument, options: LayoutOptions): MarkdownLayout {
  const width = normalizeWidth(options.width);
  const rows = layoutBlocks({
    blocks: document.blocks,
    width,
    keyPrefix: 'block',
    previousBlock: options.previousBlock,
    glyphs: options.glyphs,
  });
  return {
    width,
    rows,
    height: rows.reduce((sum, row) => sum + row.height, 0),
  };
}

export function markdownLayoutTail(
  rows: readonly MarkdownLayoutRow[],
): MarkdownLayoutTail | undefined {
  const last = rows.at(-1);
  if (last === undefined) return undefined;
  return {
    kind: last.blockKind,
    endsWithBlankLine: isBlankLine(last.lines.at(-1)),
  };
}

function isBlankLine(line: MarkdownLayoutLine | undefined): boolean {
  return line?.segments.every((segment) => segment.text.trim().length === 0) === true;
}

function layoutBlocks(input: {
  blocks: readonly MarkdownBlock[];
  width: number;
  keyPrefix: string;
  previousBlock: MarkdownLayoutTail | undefined;
  glyphs: MarkdownLayoutGlyphs;
}): MarkdownLayoutRow[] {
  const { blocks, width, keyPrefix, glyphs } = input;
  const rows: MarkdownLayoutRow[] = [];
  let previous = input.previousBlock;

  blocks.forEach((block, index) => {
    const blockRows = layoutBlock({
      block,
      width,
      key: `${keyPrefix}-${index}`,
      previousBlock: previous,
      glyphs,
    });
    rows.push(...blockRows);
    // Blocks that render nothing (HTML comments) must not shadow the tail the next
    // block compares against, or the chunked path and the whole-document path disagree.
    previous = markdownLayoutTail(blockRows) ?? previous;
  });

  return rows;
}

function leadsWithGap(block: MarkdownBlock, previous: MarkdownLayoutTail | undefined): boolean {
  if (previous === undefined) return false;
  // A loose list item already closes on a blank line; adding another would double the air.
  if (previous.endsWithBlankLine) return false;
  if (block.kind === 'heading') return true;
  if (previous.kind === 'heading') return false;
  // A fence closes on its own rail. Without air after it, the next block's first row butts
  // against that rail and two adjacent fences read as one long block with a gap in the middle.
  if (previous.kind === 'code') return true;
  return block.kind === 'paragraph' || block.kind === 'thematicBreak';
}

function layoutBlock(input: {
  block: MarkdownBlock;
  width: number;
  key: string;
  previousBlock: MarkdownLayoutTail | undefined;
  glyphs: MarkdownLayoutGlyphs;
}): MarkdownLayoutRow[] {
  const { block, width, key, previousBlock, glyphs } = input;
  const leadingGap = leadsWithGap(block, previousBlock);
  switch (block.kind) {
    case 'frontmatter':
      if (block.role === 'document') return [];
      return [createRow(key, block.kind, literalLines(block.lines, 'metadata', [], width))];
    case 'heading': {
      const wrapped = wrapSegments({
        segments: block.inlines.map((token) => headingTokenToSegment(token, block.depth)),
        firstPrefix: [],
        continuationPrefix: [],
        width,
        mode: 'word',
      });
      // The document title is the one heading with no heavier rank above it to place it, so it
      // carries a hairline instead of borrowing weight the deeper ranks also use. The hairline
      // runs the width of the title, not the terminal, so it underlines rather than divides —
      // a full-width rule is what a thematic break looks like.
      const lines =
        block.depth === 1 ? [...wrapped, headingRuleLine(wrapped, width, glyphs)] : wrapped;
      return [createRow(key, block.kind, leadingGap ? [{ segments: [] }, ...lines] : lines)];
    }
    case 'thematicBreak': {
      const lines = [thematicBreakLine(width, glyphs)];
      return [createRow(key, block.kind, leadingGap ? [{ segments: [] }, ...lines] : lines)];
    }
    case 'code':
      return withLeadingGap(
        [createRow(key, block.kind, layoutCodeBlockLines({ block, width, glyphs }))],
        leadingGap,
      );
    case 'list':
      return withLeadingGap(
        block.items.map((item, index) => layoutListItem(item, width, `${key}-${index}`, glyphs)),
        leadingGap,
      );
    case 'blockquote':
      return layoutBlockquote({ blocks: block.blocks, width, key, previousBlock, glyphs });
    case 'table':
      return withLeadingGap(layoutMarkdownTable({ block, width, key, glyphs }), leadingGap);
    case 'htmlComment':
      return [];
    case 'paragraph': {
      const lines = wrapSegments({
        segments: block.inlines.map(inlineTokenToSegment),
        firstPrefix: [],
        continuationPrefix: [],
        width,
        mode: 'word',
      });
      return [createRow(key, block.kind, leadingGap ? [{ segments: [] }, ...lines] : lines)];
    }
    default:
      return assertNever(block);
  }
}

// Blocks that own more than one row take their air on the first of them, so the gap belongs to
// the block it opens rather than trailing the one it follows.
function withLeadingGap(
  rows: readonly MarkdownLayoutRow[],
  leadingGap: boolean,
): MarkdownLayoutRow[] {
  const first = rows[0];
  if (!leadingGap || first === undefined) return [...rows];
  return [
    createRow(first.key, first.blockKind, [{ segments: [] }, ...first.lines]),
    ...rows.slice(1),
  ];
}

function literalLines(
  sourceLines: readonly string[],
  segmentKind: MarkdownLayoutSegment['kind'],
  prefix: readonly MarkdownLayoutSegment[],
  width: number,
): MarkdownLayoutLine[] {
  const lines = sourceLines.length > 0 ? sourceLines : [''];
  return lines.flatMap((line) =>
    wrapSegments({
      segments: [{ kind: segmentKind, text: line }],
      firstPrefix: prefix,
      continuationPrefix: prefix,
      width,
      mode: 'hard',
    }),
  );
}

function layoutListItem(
  item: MarkdownListItem,
  width: number,
  key: string,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutRow {
  const bullet = item.indent > 0 ? `${glyphs.listBulletNested} ` : `${glyphs.listBullet} `;
  const marker = item.kind === 'ordered' ? `${item.marker} ` : bullet;
  const indent = Math.min(item.indent, Math.max(0, width - getTerminalCellWidth(marker) - 1));
  const prefixText = `${' '.repeat(indent)}${marker}`;
  const prefix: MarkdownLayoutSegment[] = [{ kind: 'listMarker', text: prefixText }];
  const continuation: MarkdownLayoutSegment[] = [
    { kind: 'listMarker', text: ' '.repeat(prefixText.length) },
  ];

  const lines = wrapSegments({
    segments: item.inlines.map(inlineTokenToSegment),
    firstPrefix: prefix,
    continuationPrefix: continuation,
    width,
    mode: 'word',
  });
  if (item.continuation === undefined) return createRow(key, 'list', lines);

  // The continuation paragraph hangs at the item's own text column so it reads as part of
  // that item, and the blank line closes the item below it — air the next bullet inherits
  // from above instead of a gap that would cut this paragraph off from its own bullet.
  return createRow(key, 'list', [
    ...lines,
    ...wrapSegments({
      segments: item.continuation.inlines.map(inlineTokenToSegment),
      firstPrefix: continuation,
      continuationPrefix: continuation,
      width,
      mode: 'word',
    }),
    { segments: [] },
  ]);
}

function layoutBlockquote(input: {
  blocks: readonly MarkdownBlock[];
  width: number;
  key: string;
  previousBlock: MarkdownLayoutTail | undefined;
  glyphs: MarkdownLayoutGlyphs;
}): MarkdownLayoutRow[] {
  const { blocks, width, key, previousBlock, glyphs } = input;
  const quotePrefix = blockquotePrefix(width);
  const innerWidth = Math.max(2, width - getTerminalCellWidth(quotePrefix.text));
  const innerRows = layoutBlocks({
    blocks,
    width: innerWidth,
    keyPrefix: `${key}-quote`,
    previousBlock,
    glyphs,
  });

  if (innerRows.length === 0) {
    return [createRow(key, 'blockquote', [{ segments: [quotePrefix] }])];
  }

  return innerRows.map((row, index) =>
    createRow(
      `${key}-${index}`,
      'blockquote',
      row.lines.map((line) => ({
        segments: quotePrefix.text.length === 0 ? line.segments : [quotePrefix, ...line.segments],
      })),
    ),
  );
}

function blockquotePrefix(width: number): MarkdownLayoutSegment {
  if (width <= 2) return { kind: 'blockquoteMarker', text: '' };
  if (width === 3) return { kind: 'blockquoteMarker', text: '▎' };
  return { kind: 'blockquoteMarker', text: '▎ ' };
}

function createRow(
  key: string,
  blockKind: MarkdownLayoutRow['blockKind'],
  lines: readonly MarkdownLayoutLine[],
): MarkdownLayoutRow {
  const safeLines = lines.length > 0 ? lines : [{ segments: [] }];
  return {
    key,
    blockKind,
    lines: safeLines,
    height: safeLines.length,
  };
}

function headingTokenToSegment(
  token: MarkdownInlineToken,
  depth: MarkdownHeadingDepth,
): MarkdownLayoutSegment {
  if (token.kind === 'text') {
    return { kind: 'heading', text: token.text, depth };
  }
  return inlineTokenToSegment(token);
}

function thematicBreakLine(width: number, glyphs: MarkdownLayoutGlyphs): MarkdownLayoutLine {
  return { segments: [{ kind: 'rule', text: glyphs.divider.repeat(Math.max(1, width)) }] };
}

function headingRuleLine(
  lines: readonly MarkdownLayoutLine[],
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine {
  const longest = lines.reduce((max, line) => Math.max(max, measureSegments(line.segments)), 0);
  return thematicBreakLine(Math.min(width, longest), glyphs);
}

function normalizeWidth(width: number): number {
  return Math.max(8, Math.floor(width));
}
