import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { wrappedTextBlock } from './row-block-compose.js';
import { rowText } from './row-format/rows.js';
import { rowLeadingCells } from './row-markers.js';

function textBlock(input: Parameters<typeof wrappedTextBlock>[0]) {
  const block = wrappedTextBlock(input);
  if (block === null) throw new Error('Expected a wrapped text block');
  return block;
}

describe('wrappedTextBlock', () => {
  const input = { keyPrefix: 'text', text: 'abcdefghij', width: 9, tone: 'text' } as const;

  it('the first line keeps the full width when continuations hang', () => {
    const options = { ...input, width: 11, indent: 2, continuationIndent: 2 };
    const fitting = textBlock({ ...options, text: 'abcdef' });

    expect(fitting.rowCount).toBe(1);
    expect(fitting.createRows(0, fitting.rowCount).map(rowText)).toEqual(['  abcdef']);

    const longer = textBlock({ ...options, text: 'abcdefghijklmn' });
    const rows = longer.createRows(0, longer.rowCount);
    expect(rows.map(rowText)).toEqual(['  abcdef', '    ghij', '    klmn']);
    for (const [index, row] of rows.entries()) {
      const indent = options.indent + (index === 0 ? 0 : options.continuationIndent);
      const budget = options.width - rowLeadingCells(row.kind);
      expect(rowText(row).search(/\S/)).toBe(indent);
      expect(getTerminalCellWidth(rowText(row).slice(indent))).toBe(budget - indent);
    }
  });

  it('adds spaces only to soft continuations and reserves their width', () => {
    const block = textBlock({ ...input, continuationIndent: 2 });

    expect(block.createRows(0, block.rowCount).map(rowText)).toEqual(['abcdef', '  ghij']);
  });

  it('keeps the default wrapping and indentation unchanged', () => {
    for (const continuationIndent of [undefined, 0]) {
      const block = textBlock({
        ...input,
        ...(continuationIndent === undefined ? {} : { continuationIndent }),
      });
      expect(block.createRows(0, block.rowCount).map(rowText)).toEqual(['abcdef', 'ghij']);

      const indented = textBlock({
        ...input,
        indent: 2,
        ...(continuationIndent === undefined ? {} : { continuationIndent }),
      });
      expect(indented.createRows(0, indented.rowCount).map(rowText)).toEqual([
        '  abcd',
        '  efgh',
        '  ij',
      ]);
    }
  });

  it('adds the continuation indent to the row indent', () => {
    const block = textBlock({ ...input, width: 11, indent: 2, continuationIndent: 2 });

    expect(block.createRows(0, block.rowCount).map(rowText)).toEqual(['  abcdef', '    ghij']);
  });

  it('resets the continuation indent at each explicit source line', () => {
    const block = textBlock({
      ...input,
      text: 'abcdefgh\n\nijklmnop\n',
      width: 11,
      indent: 2,
      continuationIndent: 2,
    });

    expect(block.createRows(0, block.rowCount).map(rowText)).toEqual([
      '  abcdef',
      '    gh',
      '  ',
      '  ijklmn',
      '    op',
      '  ',
    ]);
  });

  it('drops separators at the first and later soft boundaries', () => {
    const block = textBlock({
      ...input,
      text: 'aaaa bbbb · ccccc · dddd · eeee\n· item',
      width: 12,
      continuationIndent: 2,
    });
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map((row) => rowText(row).trim())).toEqual([
      'aaaa bbbb',
      'ccccc',
      'dddd',
      'eeee',
      '· item',
    ]);
    for (const row of rows.slice(0, 4)) {
      expect(rowText(row).trimStart().startsWith('·')).toBe(false);
      expect(rowText(row).trimEnd().endsWith(' ·')).toBe(false);
    }
  });

  it.each([9, 16, 40])('keeps every row within %i terminal cells', (width) => {
    for (const kind of ['message', 'activity'] as const) {
      const block = textBlock({
        ...input,
        text: '\u001b[31m日本語 👩‍💻 e\u0301\u001b[0m abcdefghijklmnop\n日本語 日本語',
        width,
        kind,
        indent: 2,
        continuationIndent: 2,
      });
      for (const row of block.createRows(0, block.rowCount)) {
        expect(getTerminalCellWidth(rowText(row)) + rowLeadingCells(row.kind)).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });

  it('keeps the continuation indent when a window starts on that row', () => {
    const block = textBlock({ ...input, continuationIndent: 2 });
    const rows = block.createRows(0, block.rowCount);

    expect(block.createRows(1, 3).map(rowText)).toEqual(['  ghij']);
    expect(block.createRows(1, 3)).toEqual(rows.slice(1, 3));
    expect(block.createRows(1, 2)[0]?.key).toBe('text-1');
  });
});
