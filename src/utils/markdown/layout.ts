import type {
  MarkdownBlock,
  MarkdownDocument,
  MarkdownInlineToken,
  MarkdownLayout,
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
  MarkdownListItem,
} from './types.js';
import { getTerminalCellWidth, splitTerminalGraphemes } from '../display-text.js';
import { assertNever } from '../type-guards.js';

interface LayoutOptions {
  width: number;
}

type WrapMode = 'word' | 'hard';

export function layoutMarkdown(document: MarkdownDocument, options: LayoutOptions): MarkdownLayout {
  const width = normalizeWidth(options.width);
  const rows = layoutBlocks(document.blocks, width, 'block');
  return {
    width,
    rows,
    height: rows.reduce((sum, row) => sum + row.height, 0),
  };
}

function layoutBlocks(
  blocks: readonly MarkdownBlock[],
  width: number,
  keyPrefix: string,
): MarkdownLayoutRow[] {
  const rows: MarkdownLayoutRow[] = [];

  blocks.forEach((block, index) => {
    rows.push(...layoutBlock(block, width, `${keyPrefix}-${index}`));
  });

  return rows;
}

function layoutBlock(block: MarkdownBlock, width: number, key: string): MarkdownLayoutRow[] {
  switch (block.kind) {
    case 'frontmatter':
      return [layoutLiteralLines(block.kind, key, block.lines, 'metadata', [], [], width)];
    case 'heading':
      return [
        createRow(
          key,
          block.kind,
          wrapSegments(block.inlines.map(headingTokenToSegment), [], [], width, 'word'),
        ),
      ];
    case 'thematicBreak':
      return [
        createRow(key, block.kind, [
          { segments: [{ kind: 'rule', text: '─'.repeat(Math.max(1, width)) }] },
        ]),
      ];
    case 'code':
      return [
        layoutLiteralLines(
          block.kind,
          key,
          block.lines,
          'code',
          literalPrefix(),
          literalPrefix(),
          width,
        ),
      ];
    case 'list':
      return block.items.map((item, index) => layoutListItem(item, width, `${key}-${index}`));
    case 'blockquote':
      return layoutBlockquote(block.blocks, width, key);
    case 'paragraph':
      return [
        createRow(
          key,
          block.kind,
          wrapSegments(block.inlines.map(inlineTokenToSegment), [], [], width, 'word'),
        ),
      ];
    default:
      return assertNever(block);
  }
}

function layoutLiteralLines(
  kind: MarkdownBlock['kind'],
  key: string,
  sourceLines: readonly string[],
  segmentKind: MarkdownLayoutSegment['kind'],
  firstPrefix: readonly MarkdownLayoutSegment[],
  continuationPrefix: readonly MarkdownLayoutSegment[],
  width: number,
): MarkdownLayoutRow {
  const lines = sourceLines.length > 0 ? sourceLines : [''];
  const layoutLines = lines.flatMap((line) =>
    wrapSegments(
      [{ kind: segmentKind, text: line }],
      firstPrefix,
      continuationPrefix,
      width,
      'hard',
    ),
  );
  return createRow(key, kind, layoutLines);
}

function layoutListItem(item: MarkdownListItem, width: number, key: string): MarkdownLayoutRow {
  const marker = item.kind === 'ordered' ? `${item.marker} ` : '• ';
  const indent = Math.min(item.indent, Math.max(0, width - getTerminalCellWidth(marker) - 1));
  const prefixText = `${' '.repeat(indent)}${marker}`;
  const prefix: MarkdownLayoutSegment[] = [{ kind: 'listMarker', text: prefixText }];
  const continuation: MarkdownLayoutSegment[] = [
    { kind: 'listMarker', text: ' '.repeat(prefixText.length) },
  ];

  return createRow(
    key,
    'list',
    wrapSegments(item.inlines.map(inlineTokenToSegment), prefix, continuation, width, 'word'),
  );
}

function layoutBlockquote(
  blocks: readonly MarkdownBlock[],
  width: number,
  key: string,
): MarkdownLayoutRow[] {
  const quotePrefix: MarkdownLayoutSegment = { kind: 'blockquoteMarker', text: '▎ ' };
  const innerWidth = Math.max(1, width - getTerminalCellWidth(quotePrefix.text));
  const innerRows = layoutBlocks(blocks, innerWidth, `${key}-quote`);

  if (innerRows.length === 0) {
    return [createRow(key, 'blockquote', [{ segments: [quotePrefix] }])];
  }

  return innerRows.map((row, index) =>
    createRow(
      `${key}-${index}`,
      'blockquote',
      row.lines.map((line) => ({
        segments: [quotePrefix, ...line.segments],
      })),
    ),
  );
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
  const wrapWidth = Math.max(
    1,
    width,
    measureSegments(firstPrefix) + 1,
    measureSegments(continuationPrefix) + 1,
  );
  const lines: MarkdownLayoutLine[] = [];
  let current = cloneSegments(firstPrefix);
  let currentLength = measureSegments(current);
  let prefixLength = currentLength;

  const startContinuation = () => {
    lines.push({ segments: trimTrailingSpace(current) });
    current = cloneSegments(continuationPrefix);
    currentLength = measureSegments(current);
    prefixLength = currentLength;
  };

  const appendPart = (segment: MarkdownLayoutSegment, text: string) => {
    if (text.length === 0) return;
    const last = current[current.length - 1];
    if (last?.kind === segment.kind) {
      current[current.length - 1] = { kind: last.kind, text: `${last.text}${text}` };
    } else {
      current.push({ kind: segment.kind, text });
    }
    currentLength += getTerminalCellWidth(text);
  };

  const appendHard = (segment: MarkdownLayoutSegment, text: string) => {
    let rest = splitTerminalGraphemes(text);
    while (rest.length > 0) {
      const capacity = Math.max(0, wrapWidth - currentLength);
      if (capacity === 0) {
        startContinuation();
        continue;
      }

      const chunk = takeLeadingGraphemes(rest, capacity);
      if (chunk.text.length === 0) {
        if (currentLength > prefixLength) {
          startContinuation();
          continue;
        }
        const grapheme = rest[0];
        if (grapheme === undefined) break;
        appendPart(segment, grapheme);
        rest = rest.slice(1);
        if (rest.length > 0) startContinuation();
        continue;
      }

      appendPart(segment, chunk.text);
      rest = rest.slice(chunk.count);

      if (rest.length > 0) {
        startContinuation();
      }
    }
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
    if (mode === 'hard' || isHardWrappedSegment(segment)) {
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

function headingTokenToSegment(token: MarkdownInlineToken): MarkdownLayoutSegment {
  if (token.kind === 'text') {
    return { kind: 'heading', text: token.text };
  }
  return inlineTokenToSegment(token);
}

function inlineTokenToSegment(token: MarkdownInlineToken): MarkdownLayoutSegment {
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
    default:
      return assertNever(token);
  }
}

function literalPrefix(): MarkdownLayoutSegment[] {
  return [{ kind: 'text', text: '  ' }];
}

function isHardWrappedSegment(segment: MarkdownLayoutSegment): boolean {
  return segment.kind === 'code';
}

function trimTrailingSpace(segments: readonly MarkdownLayoutSegment[]): MarkdownLayoutSegment[] {
  const trimmed = cloneSegments(segments);
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last === undefined) break;
    const text = last.text.replace(/\s+$/g, '');
    if (text.length > 0) {
      trimmed[trimmed.length - 1] = { kind: last.kind, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

function cloneSegments(segments: readonly MarkdownLayoutSegment[]): MarkdownLayoutSegment[] {
  return segments.map((segment) => ({ kind: segment.kind, text: segment.text }));
}

function takeLeadingGraphemes(
  graphemes: readonly string[],
  maxCells: number,
): { text: string; count: number } {
  let width = 0;
  const parts: string[] = [];

  for (const grapheme of graphemes) {
    const nextWidth = getTerminalCellWidth(grapheme);
    if (width + nextWidth > maxCells) break;
    parts.push(grapheme);
    width += nextWidth;
  }

  return { text: parts.join(''), count: parts.length };
}

function measureSegments(segments: readonly MarkdownLayoutSegment[]): number {
  return segments.reduce((sum, segment) => sum + getTerminalCellWidth(segment.text), 0);
}

function normalizeWidth(width: number): number {
  return Math.max(8, Math.floor(width));
}
