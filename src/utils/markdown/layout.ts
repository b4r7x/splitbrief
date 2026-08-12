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
import {
  getTerminalCellWidth,
  splitTerminalGraphemes,
  wrapTerminalGraphemes,
} from '../display-text.js';
import { highlightMarkdownCode, type MarkdownHighlightSpan } from './highlight.js';
import {
  appendSegment,
  inlineTokenToSegment,
  measureSegments,
  trimTrailingSpace,
} from './layout-segments.js';
import { layoutMarkdownTable } from './layout-table.js';
import { assertNever } from '../type-guards.js';

interface LayoutOptions {
  width: number;
  glyphs: MarkdownLayoutGlyphs;
  previousBlock?: MarkdownLayoutTail | undefined;
}

type WrapMode = 'word' | 'hard';
const MIN_HANGING_CODE_CELLS = 8;
// Info strings that name no language. They label the fence with nothing the reader does not
// already see, so the block opens on the bare rail instead.
const UNINFORMATIVE_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  'text',
  'txt',
  'plain',
  'plaintext',
  'none',
  'raw',
  'output',
]);

export function layoutMarkdown(document: MarkdownDocument, options: LayoutOptions): MarkdownLayout {
  const width = normalizeWidth(options.width);
  const rows = layoutBlocks(document.blocks, width, 'block', options.previousBlock, options.glyphs);
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

function layoutBlocks(
  blocks: readonly MarkdownBlock[],
  width: number,
  keyPrefix: string,
  previousBlock: MarkdownLayoutTail | undefined,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutRow[] {
  const rows: MarkdownLayoutRow[] = [];
  let previous = previousBlock;

  blocks.forEach((block, index) => {
    const blockRows = layoutBlock(block, width, `${keyPrefix}-${index}`, previous, glyphs);
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

function layoutBlock(
  block: MarkdownBlock,
  width: number,
  key: string,
  previousBlock: MarkdownLayoutTail | undefined,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutRow[] {
  const leadingGap = leadsWithGap(block, previousBlock);
  switch (block.kind) {
    case 'frontmatter':
      if (block.role === 'document') return [];
      return [createRow(key, block.kind, literalLines(block.lines, 'metadata', [], width))];
    case 'heading': {
      const wrapped = wrapSegments(
        block.inlines.map((token) => headingTokenToSegment(token, block.depth)),
        [],
        [],
        width,
        'word',
      );
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
    case 'code': {
      const spans = highlightMarkdownCode({ lines: block.lines, language: block.language });
      const highlighted = spans !== null && hasHighlightScope(spans) ? spans : undefined;
      const lines =
        highlighted === undefined
          ? plainCodeLines(block.lines, width, glyphs)
          : highlightedCodeLines(highlighted, width, glyphs);
      return withLeadingGap(
        [
          createRow(key, block.kind, [
            ...codeOpenLines(block.language, width, glyphs),
            ...lines,
            codeCloseLine(glyphs),
          ]),
        ],
        leadingGap,
      );
    }
    case 'list':
      return withLeadingGap(
        block.items.map((item, index) => layoutListItem(item, width, `${key}-${index}`, glyphs)),
        leadingGap,
      );
    case 'blockquote':
      return layoutBlockquote(block.blocks, width, key, previousBlock, glyphs);
    case 'table':
      return withLeadingGap(layoutMarkdownTable({ block, width, key, glyphs }), leadingGap);
    case 'htmlComment':
      return [];
    case 'paragraph': {
      const lines = wrapSegments(block.inlines.map(inlineTokenToSegment), [], [], width, 'word');
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
    wrapSegments([{ kind: segmentKind, text: line }], prefix, prefix, width, 'hard'),
  );
}

// A fence whose highlighter produced no scoped span carries no syntax meaning, so it
// wraps on words and hangs continuations at its own indent instead of breaking mid-token.
function plainCodeLines(
  sourceLines: readonly string[],
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine[] {
  const lines = sourceLines.length > 0 ? sourceLines : [''];
  return lines.flatMap((line) => {
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    // Past this point the hanging indent leaves too little room to wrap into, and every
    // continuation would hold a cell or two, so the line falls back to the hard split.
    if (
      measureSegments(codeWrapPrefix(glyphs)) +
        getTerminalCellWidth(indent) +
        MIN_HANGING_CODE_CELLS >
      width
    ) {
      return wrapSegments(
        [{ kind: 'codeText', text: line }],
        codeGutterPrefix(glyphs),
        codeWrapPrefix(glyphs),
        width,
        'hard',
      );
    }
    const hang: MarkdownLayoutSegment[] =
      indent.length > 0 ? [{ kind: 'codeText', text: indent }] : [];
    return wrapSegments(
      [{ kind: 'codeText', text: line.slice(indent.length) }],
      [...codeGutterPrefix(glyphs), ...hang],
      [...codeWrapPrefix(glyphs), ...hang],
      width,
      'word',
    );
  });
}

function highlightedCodeLines(
  spanLines: readonly (readonly MarkdownHighlightSpan[])[],
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine[] {
  const lines = spanLines.length > 0 ? spanLines : [[]];
  return lines.flatMap((spans) =>
    wrapSegments(
      spans.map(highlightSpanToSegment),
      codeGutterPrefix(glyphs),
      codeWrapPrefix(glyphs),
      width,
      'hard',
    ),
  );
}

function hasHighlightScope(spanLines: readonly (readonly MarkdownHighlightSpan[])[]): boolean {
  return spanLines.some((spans) => spans.some((span) => span.scope !== undefined));
}

function highlightSpanToSegment(span: MarkdownHighlightSpan): MarkdownLayoutSegment {
  if (span.scope === undefined) {
    return { kind: 'codeText', text: span.text };
  }
  return { kind: 'code', text: span.text, scope: span.scope };
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

  const lines = wrapSegments(
    item.inlines.map(inlineTokenToSegment),
    prefix,
    continuation,
    width,
    'word',
  );
  if (item.continuation === undefined) return createRow(key, 'list', lines);

  // The continuation paragraph hangs at the item's own text column so it reads as part of
  // that item, and the blank line closes the item below it — air the next bullet inherits
  // from above instead of a gap that would cut this paragraph off from its own bullet.
  return createRow(key, 'list', [
    ...lines,
    ...wrapSegments(
      item.continuation.inlines.map(inlineTokenToSegment),
      continuation,
      continuation,
      width,
      'word',
    ),
    { segments: [] },
  ]);
}

function layoutBlockquote(
  blocks: readonly MarkdownBlock[],
  width: number,
  key: string,
  previousBlock: MarkdownLayoutTail | undefined,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutRow[] {
  const quotePrefix = blockquotePrefix(width);
  const innerWidth = Math.max(2, width - getTerminalCellWidth(quotePrefix.text));
  const innerRows = layoutBlocks(blocks, innerWidth, `${key}-quote`, previousBlock, glyphs);

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

function wrapSegments(
  segments: readonly MarkdownLayoutSegment[],
  firstPrefix: readonly MarkdownLayoutSegment[],
  continuationPrefix: readonly MarkdownLayoutSegment[],
  width: number,
  mode: WrapMode,
): MarkdownLayoutLine[] {
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

function headingTokenToSegment(
  token: MarkdownInlineToken,
  depth: MarkdownHeadingDepth,
): MarkdownLayoutSegment {
  if (token.kind === 'text') {
    return { kind: 'heading', text: token.text, depth };
  }
  return inlineTokenToSegment(token);
}

function codeGutterPrefix(glyphs: MarkdownLayoutGlyphs): MarkdownLayoutSegment[] {
  return [{ kind: 'codeGutter', text: `${glyphs.codeRail} ` }];
}

function codeWrapPrefix(glyphs: MarkdownLayoutGlyphs): MarkdownLayoutSegment[] {
  return [{ kind: 'codeGutter', text: `${glyphs.codeRail}${glyphs.wrapContinuation}` }];
}

// The tag sits flush with the block's right edge so it never occupies the column the code
// starts in, and it wraps like any other content when it cannot: an unwrapped row would
// report height 1 for something the terminal breaks across several lines, and the
// virtualized window measures rows by that height.
function codeOpenLines(
  language: string | undefined,
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine[] {
  const label = codeLanguageLabel(language);
  if (label === undefined) return [codeCloseLine(glyphs)];

  const railWidth = getTerminalCellWidth(glyphs.codeRail);
  const pad = width - railWidth - getTerminalCellWidth(label);
  if (pad < 1) {
    return wrapSegments(
      [{ kind: 'codeLanguage', text: label }],
      codeGutterPrefix(glyphs),
      codeGutterPrefix(glyphs),
      width,
      'hard',
    );
  }

  return [
    {
      segments: [
        { kind: 'codeGutter', text: `${glyphs.codeRail}${' '.repeat(pad)}` },
        { kind: 'codeLanguage', text: label },
      ],
    },
  ];
}

function codeLanguageLabel(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  const label = language.trim();
  if (label.length === 0) return undefined;
  return UNINFORMATIVE_CODE_LANGUAGES.has(label.toLowerCase()) ? undefined : label;
}

function codeCloseLine(glyphs: MarkdownLayoutGlyphs): MarkdownLayoutLine {
  return { segments: [{ kind: 'codeGutter', text: glyphs.codeRail }] };
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

function normalizeWidth(width: number): number {
  return Math.max(8, Math.floor(width));
}
