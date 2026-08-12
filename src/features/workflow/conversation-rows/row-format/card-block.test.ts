import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { prepareCardRows } from './card-block.js';

function rowsOf(input: Parameters<typeof prepareCardRows>[0]) {
  const card = prepareCardRows(input);
  return card.createRows(0, card.rowCount);
}

describe('prepareCardRows', () => {
  it('carries an href on a body segment through to the row', () => {
    const rows = rowsOf({
      keyPrefix: 'card',
      label: 'wrote',
      bodyLines: [
        {
          text: 'src/app/root.tsx',
          segments: [
            { text: 'src/app/root.tsx', tone: 'reviewFile', href: 'file:///repo/src/app/root.tsx' },
          ],
        },
      ],
      width: 80,
    });

    const linked = rows
      .flatMap((row) => row.segments)
      .find((segment) => segment.href !== undefined);
    expect(linked).toEqual(
      expect.objectContaining({
        text: 'src/app/root.tsx',
        tone: 'reviewFile',
        href: 'file:///repo/src/app/root.tsx',
      }),
    );
  });

  it('carries an href on a meta segment through to the header row', () => {
    const rows = rowsOf({
      keyPrefix: 'card',
      label: 'wrote',
      metaSegments: [{ text: 'open', tone: 'reviewFile', href: 'file:///repo/spec.md' }],
      bodyLines: [{ text: 'body' }],
      width: 80,
    });

    const header = rows[0];
    expect(header?.kind).toBe('card-top');
    expect(header?.segments).toContainEqual(
      expect.objectContaining({ text: 'open', tone: 'reviewFile', href: 'file:///repo/spec.md' }),
    );
  });

  it('keeps the href on every row a wrapped link spans', () => {
    const href = 'file:///repo/a/very/long/path/that/has/to/wrap/across/two/rows/index.ts';
    const text =
      'a/very/long/path/that/has/to/wrap/across/two/rows/index.ts and then some trailing prose';
    const rows = rowsOf({
      keyPrefix: 'card',
      label: 'wrote',
      bodyLines: [{ text, segments: [{ text, tone: 'reviewFile', href }] }],
      width: 40,
    });

    const bodyRows = rows.filter((row) => row.kind === 'card-body');
    expect(bodyRows.length).toBeGreaterThan(1);
    for (const bodyRow of bodyRows) {
      expect(bodyRow.segments.some((segment) => segment.href === href)).toBe(true);
    }
  });

  it('preserves distinct segment styling when a body line fits on one row', () => {
    const rows = rowsOf({
      keyPrefix: 'card',
      label: 'diff',
      bodyLines: [
        {
          text: '+3 -1',
          segments: [{ text: '+3', tone: 'success' }, { text: ' ' }, { text: '-1', tone: 'error' }],
        },
      ],
      width: 80,
    });

    const body = rows.find((row) => row.kind === 'card-body');
    expect(body?.segments.map((segment) => segment.tone)).toEqual([
      undefined,
      'success',
      undefined,
      'error',
    ]);
  });

  it('wraps CJK, ZWJ, and zero-width combining graphemes without splitting them', () => {
    const card = prepareCardRows({
      keyPrefix: 'card',
      label: 'output',
      bodyPrefix: '        ',
      bodyLines: [{ text: '界👩‍💻e\u0301x' }],
      width: 12,
    });
    const bodyRows = card.createRows(1, card.rowCount);
    const bodyText = bodyRows.map((row) => row.segments.at(-1)?.text ?? '');

    expect(bodyText).toEqual(['界', '👩‍💻', 'e\u0301x']);
    expect(bodyText.every((line) => getTerminalCellWidth(line) <= 2)).toBe(true);
  });

  it('preserves explicit newlines while keeping an exact boundary', () => {
    const card = prepareCardRows({
      keyPrefix: 'card',
      label: 'output',
      bodyPrefix: '        ',
      bodyLines: [{ text: '界\n👩‍💻' }],
      width: 12,
    });
    const bodyRows = card.createRows(1, card.rowCount);

    expect(bodyRows.map((row) => row.segments.at(-1)?.text ?? '')).toEqual(['界', '👩‍💻']);
    expect(card.createRows(1, 2)).toEqual(bodyRows.slice(0, 1));
  });
});
