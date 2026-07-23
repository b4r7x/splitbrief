import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../display-text.js';
import { layoutMarkdownTable } from './layout-table.js';
import type {
  MarkdownLayoutLine,
  MarkdownTableAlignment,
  MarkdownTableBlock,
  MarkdownTableCell,
} from './types.js';

function lineText(line: MarkdownLayoutLine): string {
  return line.segments.map((segment) => segment.text).join('');
}

const COLUMN_SEPARATOR_CHAR = '\u2502';

function tableCell(text: string): MarkdownTableCell {
  return { text, inlines: [{ kind: 'text', text }] };
}

function tableBlock(input: {
  header: readonly string[];
  rows: readonly (readonly string[])[];
  alignments?: readonly MarkdownTableAlignment[];
}): MarkdownTableBlock {
  return {
    kind: 'table',
    alignments: input.alignments ?? input.header.map(() => 'left'),
    header: input.header.map(tableCell),
    rows: input.rows.map((row) => row.map(tableCell)),
  };
}

function tableLines(block: MarkdownTableBlock, width: number): string[] {
  return layoutMarkdownTable({ block, width, key: 'table' }).flatMap((row) =>
    row.lines.map(lineText),
  );
}

describe('layoutMarkdownTable', () => {
  it('aligns columns, separates them with borders, and underlines the header', () => {
    const block = tableBlock({
      header: ['Name', 'Qty'],
      rows: [
        ['apple', '1'],
        ['kiwi', '12'],
      ],
    });

    expect(tableLines(block, 40)).toEqual([
      'Name  │ Qty',
      '\u2500'.repeat(11),
      'apple │ 1',
      'kiwi  │ 12',
    ]);
  });

  it('pads cells according to column alignment', () => {
    const block = tableBlock({
      header: ['left', 'center', 'right'],
      rows: [['a', 'b', 'c']],
      alignments: ['left', 'center', 'right'],
    });

    expect(tableLines(block, 40)).toEqual([
      'left │ center │ right',
      '\u2500'.repeat(21),
      'a    │   b    │     c',
    ]);
  });

  it('marks header cells, separators, padding, and the underline with table segment kinds', () => {
    const rows = layoutMarkdownTable({
      block: tableBlock({ header: ['Name', 'Qty'], rows: [['apple', '1']] }),
      width: 40,
      key: 'k',
    });

    const headerSegments = rows[0]?.lines[0]?.segments ?? [];
    expect(headerSegments.map((segment) => segment.kind)).toEqual([
      'tableHeader',
      'tableBorder',
      'tableHeader',
    ]);

    const underlineSegments = rows[0]?.lines[1]?.segments ?? [];
    expect(underlineSegments.every((segment) => segment.kind === 'tableBorder')).toBe(true);

    const bodySegments = rows[1]?.lines[0]?.segments ?? [];
    expect(bodySegments.some((segment) => segment.kind === 'text')).toBe(true);
    expect(bodySegments.some((segment) => segment.kind === 'tableBorder')).toBe(true);
  });

  it('wraps overflowing cells inside their column without corrupting neighbors', () => {
    const path = 'src/features/workflow/conversation-rows/markdown-rows.ts';
    const block = tableBlock({ header: ['File', 'Note'], rows: [[path, 'ok']] });
    const width = 24;
    const rows = layoutMarkdownTable({ block, width, key: 'k' });
    const lines = rows.flatMap((row) => row.lines.map(lineText));

    expect(lines.every((line) => getTerminalCellWidth(line) <= width)).toBe(true);

    const bodyLines = (rows[1]?.lines ?? []).map(lineText);
    expect(bodyLines.length).toBeGreaterThan(1);
    expect(bodyLines[0]).toContain('ok');
    expect(
      bodyLines.map((line) => (line.split(COLUMN_SEPARATOR_CHAR)[0] ?? '').trim()).join(''),
    ).toBe(path);
  });

  it.each([8, 12, 16, 20, 28])('keeps every emitted line within width %d', (width) => {
    const block = tableBlock({
      header: ['Alpha column', 'Beta', 'Gamma column'],
      rows: [
        ['long content here that wraps', 'x', 'more long content'],
        ['a', 'medium text', 'b'],
      ],
    });
    const lines = tableLines(block, width);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => getTerminalCellWidth(line) <= width)).toBe(true);
  });

  it('keeps link segments and hrefs inside body cells', () => {
    const block: MarkdownTableBlock = {
      kind: 'table',
      alignments: ['left'],
      header: [tableCell('Docs')],
      rows: [
        [
          {
            text: '[docs](https://example.com)',
            inlines: [{ kind: 'link', text: 'docs', href: 'https://example.com' }],
          },
        ],
      ],
    };
    const rows = layoutMarkdownTable({ block, width: 40, key: 'k' });

    const link = (rows[1]?.lines[0]?.segments ?? []).find((segment) => segment.kind === 'link');
    expect(link?.text).toBe('docs');
    expect(link?.href).toBe('https://example.com');
  });
});
