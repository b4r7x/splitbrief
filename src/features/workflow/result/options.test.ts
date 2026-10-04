import { describe, expect, it } from 'vitest';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { stopMenuLayout } from '../stop/options.js';
import {
  RESULT_MENU_LEGEND,
  resultMenuFindingLines,
  resultMenuHeight,
  resultMenuRows,
  resultMenuTitle,
  resultRowCommand,
} from './options.js';

describe('resultMenuRows', () => {
  it('offers Apply, Show diff and Discard on a run whose review passed', () => {
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files: 4 });

    expect(rows.map((row) => row.id)).toEqual(['apply', 'show-diff', 'discard']);
    expect(rows.map((row) => row.label)).toEqual(['Apply', 'Show diff', 'Discard']);
    expect(rows.find((row) => row.id === 'discard')?.consequence).toContain('run.patch');
  });

  it('names an override on its Apply row', () => {
    const rows = resultMenuRows({
      override: true,
      findings: ['missing null check', 'stale doc'],
      confirming: false,
      files: 4,
    });

    expect(rows.map((row) => row.id)).toEqual(['apply', 'show-diff', 'discard']);
    expect(rows[0]?.label).toBe('Apply as is');
  });

  it('asks once before an override is applied, with Back beside it', () => {
    const rows = resultMenuRows({
      override: true,
      findings: ['missing null check', 'stale doc'],
      confirming: true,
      files: 4,
    });

    expect(rows.map((row) => row.id)).toEqual(['confirm-apply', 'back']);
    expect(rows[0]?.consequence).toBe('write the changes; these findings stay open');
  });
});

describe('resultMenuFindingLines', () => {
  it('lists every open finding that fits', () => {
    expect(resultMenuFindingLines(['missing null check', 'stale doc'], 3)).toEqual([
      '- missing null check',
      '- stale doc',
    ]);
  });

  it('counts the findings the rows cannot hold instead of dropping them silently', () => {
    const findings = Array.from({ length: 8 }, (_, index) => `finding ${index + 1}`);
    expect(resultMenuFindingLines(findings, 3)).toEqual([
      '- finding 1',
      '- finding 2',
      '+6 more open findings',
    ]);
  });

  it('gives no line when there is no room', () => {
    expect(resultMenuFindingLines(['missing null check'], 0)).toEqual([]);
  });
});

describe('resultMenuHeight', () => {
  it('adds one row per open finding while it asks', () => {
    const input = {
      override: true,
      findings: ['missing null check', 'stale doc'],
      confirming: false,
      files: 4,
    };
    const asking = { ...input, confirming: true };
    expect(resultMenuHeight(asking, 120)).toBe(
      stopMenuLayout(resultMenuRows(asking), 120).height + 2,
    );
    expect(resultMenuHeight(input, 120)).toBe(stopMenuLayout(resultMenuRows(input), 120).height);
  });
});

describe('resultMenuTitle', () => {
  it('counts the files Apply would write and says the checkout is untouched', () => {
    expect(resultMenuTitle({ override: false, findings: [], confirming: false, files: 4 })).toBe(
      'Ready to apply · 4 files changed · your checkout is untouched',
    );
  });

  it('leaves the count out when the run recorded no changed set', () => {
    expect(resultMenuTitle({ override: false, findings: [], confirming: false, files: null })).toBe(
      'Ready to apply · your checkout is untouched',
    );
  });

  it('counts the open findings of an override and never says the review passed', () => {
    const title = resultMenuTitle({
      override: true,
      findings: ['missing null check', 'stale doc'],
      confirming: false,
      files: 4,
    });
    expect(title).toBe('Ready to apply as is · 2 open findings · 4 files changed');
    expect(title).not.toContain('passed');
  });

  it('asks the confirmation as a question', () => {
    expect(
      resultMenuTitle({
        override: true,
        findings: ['missing null check'],
        confirming: true,
        files: 4,
      }),
    ).toBe('Apply with 1 open finding?');
  });
});

describe('resultRowCommand', () => {
  it('routes Apply and Discard through /run', () => {
    expect(resultRowCommand('apply')).toBe('/run accept');
    expect(resultRowCommand('confirm-apply')).toBe('/run accept confirm');
    expect(resultRowCommand('discard')).toBe('/run reject confirm');
    expect(resultRowCommand('show-diff')).toBeNull();
    expect(resultRowCommand('back')).toBeNull();
  });
});

describe('result menu layout', () => {
  it('takes the composer width and is as tall as what it paints', () => {
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files: 4 });
    const layout = stopMenuLayout(rows, 120);

    expect(layout.width).toBe(getChromeContentWidth(120));
    expect(layout.height).toBe(layout.bodyRows + 4);
    expect(layout.bodyRows).toBe(3);
  });

  it('binds no bare letters', () => {
    expect(RESULT_MENU_LEGEND).toBe('↑↓ select · ⏎ confirm · tab type a command');
  });
});
