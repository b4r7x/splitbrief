import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { rowLeadingCells, wrapWidthFor } from '../row-markers.js';
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

  it('hangs the wrapped rows of a list item under its text', () => {
    const rows = rowsOf({
      keyPrefix: 'card',
      label: 'Warning',
      bodyLines: [{ text: 'Two failed:\n- one two three four five six seven\n- eight' }],
      width: 24,
      bodyPrefix: '',
    });

    expect(
      rows.slice(1).map((row) => row.segments.map((segment) => segment.text).join('')),
    ).toEqual(['Two failed:', '- one two three', '  four five six seven', '- eight']);
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
          segments: [
            { text: '+3', tone: 'success' },
            { text: ' ', tone: 'text' },
            { text: '-1', tone: 'error' },
          ],
        },
      ],
      width: 80,
    });

    const body = rows.find((row) => row.kind === 'card-body');
    expect(body?.segments.map((segment) => segment.tone)).toEqual([
      'text',
      'success',
      'text',
      'error',
    ]);
  });

  it('wraps CJK, ZWJ, and zero-width combining graphemes without splitting them', () => {
    const card = prepareCardRows({
      keyPrefix: 'card',
      label: 'output',
      bodyPrefix: '        ',
      bodyLines: [{ text: '界👩‍💻e\u0301x' }],
      width: 13,
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
      width: 13,
    });
    const bodyRows = card.createRows(1, card.rowCount);

    expect(bodyRows.map((row) => row.segments.at(-1)?.text ?? '')).toEqual(['界', '👩‍💻']);
    expect(card.createRows(1, 2)).toEqual(bodyRows.slice(0, 1));
  });
});

describe('prepareCardRows wraps on whole words', () => {
  function bodyTexts(text: string, width: number): string[] {
    const card = prepareCardRows({
      keyPrefix: 'card',
      label: 'error',
      bodyPrefix: '',
      bodyLines: [{ text }],
      width,
    });
    return card
      .createRows(1, card.rowCount)
      .map((row) => row.segments.map((segment) => segment.text).join(''));
  }

  // The two planner halts whose callouts broke "swit|ch" at 120 columns and "fix t|his" at 80,
  // in the words `diagnosePlannerCallFailure` writes them now.
  it.each([
    [
      'Codex',
      "Planning failed: You've hit your usage limit. OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the PLAN tool, then continue.",
    ],
    [
      'Claude Code',
      "Planning failed: You've hit your session limit. Claude Code CLI hit its usage limit. Wait for the limit to reset or change the PLAN tool, then continue.",
    ],
  ])('breaks the %s halt only between words, at every width', (_tool, text) => {
    for (let width = 30; width <= 120; width += 1) {
      const lines = bodyTexts(text, width);

      expect(lines.join(' '), `width ${width}`).toBe(text);
      for (const line of lines) {
        expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(wrapWidthFor('card-body', width));
      }
    }
  });

  it('keeps a CJK phrase whole where it fits and breaks one wider than the row by whole cells', () => {
    const lines = bodyTexts(
      '計画は失敗しました 使用量の上限に達しました',
      18 + rowLeadingCells('card-body'),
    );

    expect(lines).toEqual(['計画は失敗しました', '使用量の上限に達し', 'ました']);
  });

  it('keeps emoji graphemes and the words around them whole', () => {
    const lines = bodyTexts(
      'wait 👩‍💻 for the ⚠️ reset 🇵🇱 then switch',
      14 + rowLeadingCells('card-body'),
    );

    expect(lines).toEqual(['wait 👩‍💻 for', 'the ⚠️ reset', '🇵🇱 then switch']);
    for (const line of lines) expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(14);
  });

  it('measures a zero-width space the way the row paints it', () => {
    const word = 'ab\u200bcd';
    const lines = bodyTexts(
      Array.from({ length: 6 }, () => word).join(' '),
      10 + rowLeadingCells('card-body'),
    );

    for (const line of lines) expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.join(' ').split(' ')).toEqual(Array.from({ length: 6 }, () => word));
  });

  it('drops a separator only when wrapping it onto a card continuation', () => {
    const cases = [
      { text: '1234567 · abcdef', width: 10, expected: ['1234567', 'abcdef'] },
      { text: 'abcdefgh · 👩‍💻', width: 12, expected: ['abcdefgh', '👩‍💻'] },
    ];

    for (const testCase of cases) {
      const lines = bodyTexts(testCase.text, testCase.width);

      expect(lines, `width ${testCase.width}`).toEqual(testCase.expected);
      expect(
        lines.every((line) => !line.startsWith('·')),
        `width ${testCase.width}`,
      ).toBe(true);
      for (const line of lines) {
        expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(
          wrapWidthFor('card-body', testCase.width),
        );
      }
    }

    expect(bodyTexts('first · item', 30)).toEqual(['first · item']);
    expect(bodyTexts('first\n· item', 30)).toEqual(['first', '· item']);
  });
});
