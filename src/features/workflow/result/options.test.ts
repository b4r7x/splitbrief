import { describe, expect, it } from 'vitest';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { stopMenuLayout } from '../stop/options.js';
import {
  RESULT_MENU_LEGEND,
  resultMenuFindingLines,
  resultMenuHeight,
  resultMenuRows,
  resultMenuTitle as titleParts,
  resultRowCommand,
} from './options.js';

function resultMenuTitle(input: Parameters<typeof titleParts>[0]): string {
  return titleParts(input)
    .map((part) => part.text)
    .join('');
}

it('keeps the ready state, facts and separators in distinct title parts', () => {
  expect(titleParts({ override: false, findings: [], confirming: false, files: 4 })).toEqual([
    { text: 'Ready to apply', tone: 'accent' },
    { text: ' · ', tone: 'textDim' },
    { text: '4 files changed', tone: 'textDim' },
    { text: ' · ', tone: 'textDim' },
    { text: 'run changes await Apply', tone: 'textDim' },
  ]);
  expect(titleParts({ override: true, findings: ['issue'], confirming: true, files: 4 })).toEqual([
    { text: 'Apply with 1 open finding?', tone: 'warning' },
  ]);
});

describe('resultMenuRows', () => {
  it('offers Apply, Show diff and Discard on a run whose review passed', () => {
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files: 4 });

    expect(rows.map((row) => row.id)).toEqual(['apply', 'show-diff', 'discard']);
    expect(rows.map((row) => row.label)).toEqual(['Apply', 'Show diff', 'Discard']);
    expect(rows.find((row) => row.id === 'discard')?.consequence).toContain('run.patch');
  });

  it('promises no patch when the run changed no files', () => {
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files: 0 });

    const discard = rows.find((row) => row.id === 'discard');
    expect(discard?.consequence).toBe('close the run; it changed no files');
    expect(discard?.consequence).not.toContain('run.patch');
  });

  it('closes the run without promising changes on Apply when no files changed', () => {
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files: 0 });

    expect(rows.find((row) => row.id === 'apply')?.consequence).toBe(
      'close the run; it changed no files',
    );
  });

  it('closes an empty override with open findings and asks once', () => {
    const rows = resultMenuRows({
      override: true,
      findings: ['missing null check'],
      confirming: false,
      files: 0,
    });

    expect(rows.find((row) => row.id === 'apply')?.consequence).toBe(
      'close the run with the open findings; asks once',
    );
  });

  it('confirms an empty override without promising changes', () => {
    const rows = resultMenuRows({
      override: true,
      findings: ['missing null check'],
      confirming: true,
      files: 0,
    });

    expect(rows.find((row) => row.id === 'confirm-apply')?.consequence).toBe(
      'close the run; these findings stay open',
    );
  });

  it.each([4, null])('keeps the Apply consequences when files is %s', (files) => {
    const input = { override: false, findings: ['missing null check'], confirming: false, files };

    expect(resultMenuRows(input).find((row) => row.id === 'apply')?.consequence).toBe(
      'write the run’s changes into your checkout; close the run',
    );
    expect(
      resultMenuRows({ ...input, override: true }).find((row) => row.id === 'apply')?.consequence,
    ).toBe('write the changes with the open findings; asks once');
    expect(
      resultMenuRows({ ...input, override: true, confirming: true }).find(
        (row) => row.id === 'confirm-apply',
      )?.consequence,
    ).toBe('write the changes; these findings stay open');
  });

  it('keeps the patch consequence when the run recorded no changed set', () => {
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files: null });

    expect(rows.find((row) => row.id === 'discard')?.consequence).toBe(
      'close the run; save its changes in run.patch',
    );
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
  it('describes the unapplied result without asserting checkout cleanliness', () => {
    expect(resultMenuTitle({ override: false, findings: [], confirming: false, files: 4 })).toBe(
      'Ready to apply · 4 files changed · run changes await Apply',
    );
  });

  it('keeps the zero file count without promising changes await Apply', () => {
    expect(resultMenuTitle({ override: false, findings: [], confirming: false, files: 0 })).toBe(
      'Ready to apply · 0 files changed',
    );
    expect(
      resultMenuTitle({ override: true, findings: ['issue'], confirming: false, files: 0 }),
    ).toBe('Ready to apply as is · 1 open finding · 0 files changed');
  });

  it('leaves the count out when the run recorded no changed set', () => {
    expect(resultMenuTitle({ override: false, findings: [], confirming: false, files: null })).toBe(
      'Ready to apply · run changes await Apply',
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
