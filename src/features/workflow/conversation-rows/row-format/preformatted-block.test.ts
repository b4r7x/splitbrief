import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { glyph } from '../../../../lib/glyphs.js';
import { preformattedOutputBlock } from './preformatted-block.js';
import { rowText } from './rows.js';
import { wrapWidthFor } from '../row-markers.js';
import type { ConversationRow } from '../types.js';

const FOOTER = glyph('treeLast');

// The Biome format diff from the reported defect, with its line breaks intact.
const BIOME_DIFF = [
  'src/engine/providers/capability-inference.test.ts format ━━━━━━━━━━━━━━━━━━━',
  '',
  '  × Formatter would have printed the following content:',
  '  ',
  '    15 15 │     it.each([',
  "    16 16 │       ['ollama-cloud', 'kimi-k2.7-code', { state: 'supported', source: 'provider' }],",
  "    17    │ - ····['ollama-cloud',·'text-embedding-3-large',·{·state:·'unsupported',·reason:·'Model·is·not·generative'·}],",
  '       17 │ + ····[',
  "       18 │ + ······'ollama-cloud',",
  '       21 │ + ····],',
].join('\n');

function rowsOf(block: ReturnType<typeof preformattedOutputBlock>): ConversationRow[] {
  expect(block).not.toBeNull();
  if (block === null) throw new Error('rowsOf: block was null');
  return block.createRows(0, block.rowCount);
}

function build(
  overrides: {
    text?: string;
    width?: number;
    maxLines?: number;
    moreHint?: string;
    meta?: string;
  } = {},
) {
  return preformattedOutputBlock({
    keyPrefix: 'ev',
    label: 'error',
    meta: overrides.meta ?? 'lint',
    text: overrides.text ?? BIOME_DIFF,
    width: overrides.width ?? 78,
    tone: 'error',
    ...(overrides.maxLines === undefined ? {} : { maxLines: overrides.maxLines }),
    ...(overrides.moreHint === undefined ? {} : { moreHint: overrides.moreHint }),
  });
}

// Array subscripts are `ConversationRow | undefined` under noUncheckedIndexedAccess, so every row
// lookup in this file goes through this rather than through `rows[i] ?? rows[0]`, which type-checks
// nowhere and hides a missing row behind a neighbour when it does.
function textAt(rows: ConversationRow[], index: number): string {
  const found = rows.at(index);
  if (found === undefined) throw new Error(`textAt: no row at index ${index}`);
  return rowText(found);
}

function toneOfRowContaining(rows: ConversationRow[], needle: string) {
  const found = rows.find((row) => rowText(row).includes(needle));
  expect(found).toBeDefined();
  return found?.segments[0]?.tone;
}

describe('preformattedOutputBlock', () => {
  it('keeps one row per source line instead of reflowing', () => {
    const rows = rowsOf(build());
    const bodyRows = rows.filter((row) => row.kind === 'callout-body');

    expect(bodyRows).toHaveLength(BIOME_DIFF.split('\n').length);
  });

  it('preserves column alignment by cutting at the width rather than wrapping', () => {
    const rows = rowsOf(build({ width: 78 }));
    const gutterRows = rows.filter((row) => rowText(row).includes('│'));

    // Every diff line keeps its line-number gutter at the same cell, which is exactly what
    // wrapping destroyed: continuation rows used to start at column 0 with no gutter.
    const gutterColumns = new Set(gutterRows.map((row) => rowText(row).indexOf('│')));
    expect(gutterRows.length).toBeGreaterThan(4);
    expect(gutterColumns.size).toBe(1);
  });

  it('never emits a row wider than the space left by the rule leading', () => {
    for (const width of [40, 78, 110]) {
      const rows = rowsOf(build({ width }));
      for (const row of rows) {
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(width - 2);
      }
    }
  });

  it('budgets continuation, rule, and footer decorations at widths 1 through 8', () => {
    const longLine = 'diagnostic '.concat('x'.repeat(40));
    const ruledText = ['validation ━━━━━━━━━━━━━━━━━━━', '', 'context'].join('\n');

    for (const width of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const bodyWidth = wrapWidthFor('callout-body', width);
      const continuationRows = rowsOf(
        build({ text: longLine, width, maxLines: 8, moreHint: 'run lint' }),
      ).filter((row) => row.kind === 'callout-body');
      const decoratedRows = rowsOf(
        build({ text: ruledText, width, maxLines: 3, moreHint: 'run lint' }),
      ).filter((row) => row.kind === 'callout-body');

      for (const row of [...continuationRows, ...decoratedRows]) {
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(bodyWidth);
      }
    }

    expect(
      rowsOf(build({ text: longLine, width: 8, maxLines: 8 })).some((row) =>
        rowText(row).includes(glyph('wrapContinuation')),
      ),
    ).toBe(true);
  });

  it('marks a cut content line with an ellipsis and keeps its head', () => {
    const rows = rowsOf(build({ width: 60 }));
    const cut = rows.filter((row) => rowText(row).endsWith('…'));

    expect(cut.length).toBeGreaterThan(0);
    expect(textAt(cut, 0)).toMatch(/^ {4}16 16 │/);
  });

  // A tool pads its banner rule to its own terminal width, so cutting it would stamp an ellipsis
  // onto pure decoration — an ellipsis promises content was lost.
  it('re-lays a trailing rule to the exact width instead of truncating it', () => {
    for (const width of [60, 78, 110]) {
      const banner = textAt(rowsOf(build({ width })), 1);

      // The rule is decoration, so it is re-laid, never cut. A narrow width may still cut the
      // filename ahead of it — that is real content, so the ellipsis there is honest.
      expect(banner.endsWith('━')).toBe(true);
      expect(getTerminalCellWidth(banner)).toBe(width - 2);
    }

    const wide = textAt(rowsOf(build({ width: 110 })), 1);
    expect(wide).toContain('src/engine/providers/capability-inference.test.ts format');
    expect(wide).not.toContain('…');
  });

  // Polarity, not severity: a removed line inside an error block must not wear the error hue, or
  // the rail, the label and every removed row collapse into one field at sixteen colours.
  it('tints added and removed lines with the diff tones and leaves context dim', () => {
    const rows = rowsOf(build());

    expect(toneOfRowContaining(rows, "17    │ - ····['ollama-cloud'")).toBe('diffRemoved');
    expect(toneOfRowContaining(rows, '17 │ + ····[')).toBe('diffAdded');
    expect(toneOfRowContaining(rows, '15 15 │     it.each([')).toBe('diffContext');
  });

  // A tool rules off its banner with ━ because that line heads the section under it. Reading it at
  // the same weight as the context lines is what made the block one flat wash.
  it('lifts a ruled banner above the context it heads', () => {
    const rows = rowsOf(build());

    expect(toneOfRowContaining(rows, 'capability-inference.test.ts format')).toBe('text');
    expect(toneOfRowContaining(rows, '15 15 │     it.each([')).toBe('diffContext');
  });

  // A row is toned by the marker it carries, never by one on a row somewhere else. Deciding from a
  // neighbour left thirty signed rows in one flat tone whenever their counterpart fell past the
  // cut, and reading a capture the viewport never reaches is the cost this block exists to avoid.
  it('tones a signed row from its own marker even when its counterpart falls past the cut', () => {
    const removed = Array.from({ length: 30 }, (_, index) => `- removed ${index}`);
    const added = Array.from({ length: 5 }, (_, index) => `+ added ${index}`);
    const rows = rowsOf(build({ text: [...removed, ...added].join('\n'), maxLines: 30 }));
    const body = rows.filter((row) => rowText(row).startsWith('- '));

    expect(body).toHaveLength(30);
    expect(body.every((row) => row.segments[0]?.tone === 'diffRemoved')).toBe(true);
  });

  // A tool signs off with its last ruled banner and the paragraph attached to it, and that sign-off
  // repeats the validate summary row in the rows nearest the composer, identically on every
  // failure. Preformatted is not unabridged — but the dropped rows are still counted.
  it('drops the sign-off a tool rules off at the end and counts what it dropped', () => {
    const text = [
      'src/engine/providers/capability-inference.test.ts format ━━━━━━━━━━━━',
      '',
      '  × Formatter would have printed the following content:',
      '',
      '    15 15 │     it.each([',
      '',
      'Checked 1 file in 4ms. No fixes applied.',
      'Found 1 error.',
      'check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  × Some errors were emitted while running checks.',
    ].join('\n');
    const rows = rowsOf(build({ text, moreHint: 'run npm run lint' }));
    const body = rows.map(rowText).join('\n');

    expect(body).toContain('× Formatter would have printed');
    expect(body).not.toContain('Checked 1 file');
    expect(body).not.toContain('Found 1 error');
    expect(body).not.toContain('check ━');
    expect(body).not.toContain('Some errors were emitted');
    expect(textAt(rows, -1)).toBe(`${FOOTER} + 6 more lines · run npm run lint`);
  });

  // The opening banner heads the diagnostic itself, so a capture that carries only that one is
  // entirely content and nothing may be dropped from it.
  it('keeps a capture whose only ruled banner opens it', () => {
    const rows = rowsOf(build({ maxLines: 30 }));

    expect(rows.map(rowText).join('\n')).toContain('+ ····],');
    expect(rows.map(rowText).join('\n')).not.toContain('more line');
  });

  it('points the tail at the gesture that recovers the cut lines', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const rows = rowsOf(build({ text, maxLines: 30, moreHint: 'run npm run lint' }));

    expect(textAt(rows, -1)).toBe(`${FOOTER} + 10 more lines · run npm run lint`);
  });

  // Cutting the hint at the right edge would drop the test path that says which run to reproduce,
  // which is the whole reason the hint is there.
  it('keeps the end of a hint too long for the row', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const rows = rowsOf(
      build({
        text,
        width: 78,
        maxLines: 30,
        moreHint: 'run npm test -- src/features/workflow/conversation-rows/event-rows/x.test.ts',
      }),
    );
    const tail = textAt(rows, -1);

    expect(tail.startsWith(`${FOOTER} + 10 more lines · run npm test`)).toBe(true);
    expect(tail.endsWith('x.test.ts')).toBe(true);
    expect(getTerminalCellWidth(tail)).toBeLessThanOrEqual(76);
  });

  it('caps the body and reports the remainder', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const rows = rowsOf(build({ text, maxLines: 30 }));

    expect(rows.filter((row) => row.kind === 'callout-body')).toHaveLength(32);
    expect(textAt(rows, 30)).toBe('line 29');
    expect(textAt(rows, 31)).toBe('');
    expect(textAt(rows, 32)).toBe(`${FOOTER} + 10 more lines`);
  });

  it('adds the tail row only once the body passes maxLines', () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
    const exact = rowsOf(build({ text: lines(30), maxLines: 30 }));
    const over = rowsOf(build({ text: lines(31), maxLines: 30 }));

    expect(exact.map(rowText).join('\n')).not.toContain('more line');
    expect(textAt(over, -1)).toBe(`${FOOTER} + 1 more line`);
  });

  it('uses the singular noun for a single hidden line', () => {
    const text = Array.from({ length: 4 }, (_, index) => `line ${index}`).join('\n');
    const rows = rowsOf(build({ text, maxLines: 3 }));

    expect(textAt(rows, -1)).toBe(`${FOOTER} + 1 more line`);
  });

  it('labels the block with the failing step and keeps the rail structural, not severity', () => {
    const rows = rowsOf(build());

    expect(rows[0]?.kind).toBe('callout-top');
    expect(textAt(rows, 0)).toBe('error  lint');
    expect(rows[0]?.segments[0]?.tone).toBe('error');
    expect(rows.every((row) => row.markerTone === 'border')).toBe(true);
  });

  // The meta ends in the file the command ran against, which is what says which failure this is.
  it('keeps the end of a label meta too long for the row', () => {
    const header = textAt(
      rowsOf(
        build({
          width: 78,
          meta: 'test · npm test -- src/features/workflow/conversation-rows/event-rows/x.test.ts',
        }),
      ),
      0,
    );

    expect(header.startsWith('error  test · npm test')).toBe(true);
    expect(header.endsWith('x.test.ts')).toBe(true);
    expect(getTerminalCellWidth(header)).toBeLessThanOrEqual(76);
  });

  it('drops the label meta when there is no room for it', () => {
    const rows = rowsOf(build({ width: 9 }));

    expect(textAt(rows, 0)).toBe('error');
  });

  // Two blank rows inside a rail read as a rendering fault rather than as spacing, and tools emit
  // them freely, so a run collapses to the one that does the separating.
  it('trims surrounding blank lines and collapses interior runs to one', () => {
    const rows = rowsOf(build({ text: '\n\nfirst\n\n\n\nlast\n\n\n' }));
    const body = rows.filter((row) => row.kind === 'callout-body').map(rowText);

    expect(body).toEqual(['first', '', 'last']);
  });

  it('returns null for text that is only whitespace', () => {
    expect(build({ text: '   \n\n  ' })).toBeNull();
  });

  // A lone line has no neighbours to stay aligned with, so wrapping costs no structure and keeps
  // the whole message — a long tsc error would otherwise lose most of itself to the cut. Each
  // continued row is marked and indented, because a sentence wrapping flush at the start column
  // reads as a second error rather than as the rest of the first.
  it('wraps a lone long line instead of cutting it, marking every continuation', () => {
    const long = `x(1,1): error TS2345: ${'very long inferred type '.repeat(12)}`;
    const rows = rowsOf(build({ text: long, width: 78 }));
    const body = rows.filter((row) => row.kind === 'callout-body');
    const marker = `  ${glyph('wrapContinuation')} `;

    expect(body.length).toBeGreaterThan(3);
    expect(body.map((row) => row.segments.at(-1)?.text ?? '').join('')).toBe(
      long.replace(/\s+$/, ''),
    );
    expect(textAt(body, 0)).not.toContain(marker.trim());
    expect(body.slice(1).every((row) => rowText(row).startsWith(marker))).toBe(true);
    expect(body.every((row) => !rowText(row).endsWith('…'))).toBe(true);
  });

  it('caps a wrapped lone line at the same limit and still reports the remainder', () => {
    const long = 'z'.repeat(78 * 40);
    const rows = rowsOf(build({ text: long, width: 78, maxLines: 30 }));
    const body = rows.filter((row) => row.kind === 'callout-body');

    expect(body.filter((row) => rowText(row).includes('z'))).toHaveLength(30);
    expect(textAt(rows, -1)).toBe(`${FOOTER} + 14 more lines`);
  });

  // The cut is decided by line count before any line is measured, so a capture far larger than the
  // viewport costs the same as one that just overflows it.
  it('renders the same rows for a huge capture as for one just past the cap', () => {
    const rowsFor = (count: number) =>
      rowsOf(
        build({
          text: Array.from({ length: count }, (_, index) => `line ${index}`).join('\n'),
          maxLines: 30,
        }),
      ).map(rowText);

    expect(rowsFor(10_000).slice(0, -1)).toEqual(rowsFor(31).slice(0, -1));
    expect(textAt(rowsOf(build({ text: 'a\n'.repeat(10_000), maxLines: 30 })), -1)).toBe(
      `${FOOTER} + 9970 more lines`,
    );
  });

  it('still cuts each line once there is more than one', () => {
    const long = 'y'.repeat(200);
    const rows = rowsOf(build({ text: `${long}\n${long}`, width: 78 }));
    const body = rows.filter((row) => row.kind === 'callout-body');

    expect(body).toHaveLength(2);
    expect(body.every((row) => rowText(row).endsWith('…'))).toBe(true);
  });

  it('serves a window without shifting row content', () => {
    const block = build();
    expect(block).not.toBeNull();
    if (block === null) throw new Error('block was null');

    expect(block.createRows(2, 5).map(rowText)).toEqual(
      block.createRows(0, block.rowCount).slice(2, 5).map(rowText),
    );
  });
});
