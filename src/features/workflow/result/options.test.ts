import { describe, expect, it } from 'vitest';
import type { RedCheck } from '../../../core/schemas/workflow/review-record.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { stopMenuLayout } from '../inline-menu/layout.js';
import * as options from './options.js';
import {
  RESULT_MENU_LEGEND,
  resultMenuHeight,
  resultMenuNoteLines,
  resultMenuRows,
  resultMenuTitle as titleParts,
  resultRowCommand,
} from './options.js';

const V1: RedCheck = { id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' };
const K004: RedCheck = { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' };

function resultMenuTitle(input: Parameters<typeof titleParts>[0]): string {
  return titleParts(input)
    .map((part) => part.text)
    .join('');
}

function openLines(open: { redChecks?: RedCheck[]; findings: string[] }, budget: number): string[] {
  expect(options.resultMenuOpenLines).toBeTypeOf('function');
  return options.resultMenuOpenLines(open, budget);
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

  it.each([
    {
      files: 4,
      findings: ['missing null check'],
      apply: 'write the changes with the red checks and the open findings; asks once',
      confirm: 'write the changes; the red checks and these findings stay open',
    },
    {
      files: null,
      findings: [],
      apply: 'write the changes with the red checks; asks once',
      confirm: 'write the changes; the red checks stay red',
    },
    {
      files: 0,
      findings: ['missing null check'],
      apply: 'close the run with the red checks and the open findings; asks once',
      confirm: 'close the run; the red checks and these findings stay open',
    },
    {
      files: 0,
      findings: [],
      apply: 'close the run with the red checks; asks once',
      confirm: 'close the run; the red checks stay red',
    },
  ])(
    'names the red checks first on the rows of an override: $apply',
    ({ files, findings, apply, confirm }) => {
      const input = { override: true, redChecks: [V1], findings, confirming: false, files };

      expect(resultMenuRows(input).find((row) => row.id === 'apply')?.consequence).toBe(apply);
      expect(
        resultMenuRows({ ...input, confirming: true }).find((row) => row.id === 'confirm-apply')
          ?.consequence,
      ).toBe(confirm);
    },
  );
});

describe('resultMenuOpenLines', () => {
  const sixFindings = Array.from({ length: 6 }, (_, index) => `finding ${index + 1}`);

  it('lists every open finding that fits', () => {
    expect(openLines({ findings: ['missing null check', 'stale doc'] }, 3)).toEqual([
      '- missing null check',
      '- stale doc',
    ]);
  });

  it('counts the findings the rows cannot hold instead of dropping them silently', () => {
    const findings = Array.from({ length: 8 }, (_, index) => `finding ${index + 1}`);
    expect(openLines({ findings }, 3)).toEqual([
      '- finding 1',
      '- finding 2',
      '+6 more open findings',
    ]);
  });

  it('gives each finding one row, its line breaks read as spaces', () => {
    expect(openLines({ findings: ['a\nb'] }, 5)).toEqual(['- a b']);
  });

  it('gives no line when there is no room', () => {
    expect(openLines({ findings: ['missing null check'] }, 0)).toEqual([]);
    expect(openLines({ redChecks: [V1], findings: ['missing null check'] }, 0)).toEqual([]);
  });

  it('lists the red checks first, one row each, then the open findings', () => {
    expect(
      openLines({ redChecks: [V1, K004], findings: ['missing null check', 'stale doc'] }, 4),
    ).toEqual([
      '- V1 failed · npm test · Error: 2 specs failed',
      '- K004 failed · src/a.ts(3,1): TS2322',
      '- missing null check',
      '- stale doc',
    ]);
    expect(openLines({ redChecks: [V1], findings: [] }, 4)).toEqual([
      '- V1 failed · npm test · Error: 2 specs failed',
    ]);
  });

  it('gives each red check one row, the line breaks of its command read as spaces', () => {
    expect(
      openLines(
        { redChecks: [{ id: 'V2', command: 'npm run lint\n  -- --quiet' }], findings: [] },
        4,
      ),
    ).toEqual(['- V2 failed · npm run lint -- --quiet']);
  });

  it('counts only open findings on the last line while every red check has its row', () => {
    expect(openLines({ redChecks: [V1, K004], findings: sixFindings }, 4)).toEqual([
      '- V1 failed · npm test · Error: 2 specs failed',
      '- K004 failed · src/a.ts(3,1): TS2322',
      '- finding 1',
      '+5 more open findings',
    ]);
    expect(openLines({ redChecks: [V1, K004], findings: sixFindings }, 3)).toEqual([
      '- V1 failed · npm test · Error: 2 specs failed',
      '- K004 failed · src/a.ts(3,1): TS2322',
      '+6 more open findings',
    ]);
  });

  it('names the red checks on the last line when it hides one of them', () => {
    expect(openLines({ redChecks: [V1, K004], findings: sixFindings }, 2)).toEqual([
      '- V1 failed · npm test · Error: 2 specs failed',
      '+7 more red checks and open findings',
    ]);
    expect(openLines({ redChecks: [V1, K004], findings: ['stale doc'] }, 1)).toEqual([
      '+3 more red checks and open findings',
    ]);
  });

  it('names no open finding on the last line of an accept that holds none', () => {
    expect(
      openLines({ redChecks: [V1, K004, { id: 'V2' }, { id: 'V3' }], findings: [] }, 3),
    ).toEqual([
      '- V1 failed · npm test · Error: 2 specs failed',
      '- K004 failed · src/a.ts(3,1): TS2322',
      '+2 more red checks',
    ]);
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

  it.each([
    { findings: ['missing null check', 'stale doc'], rows: 4 },
    { findings: [], rows: 2 },
  ])(
    'adds one row per red check and one per open finding while it asks: $rows rows',
    ({ findings, rows }) => {
      const input = {
        override: true,
        redChecks: [V1, K004],
        findings,
        confirming: false,
        files: 4,
      };
      const asking = { ...input, confirming: true };
      expect(resultMenuHeight(asking, 120)).toBe(
        stopMenuLayout(resultMenuRows(asking), 120).height + rows,
      );
      expect(resultMenuHeight(input, 120)).toBe(stopMenuLayout(resultMenuRows(input), 120).height);
    },
  );

  it('adds the row of a one-row note while it asks', () => {
    const asking = {
      override: true,
      findings: ['missing null check'],
      note: "Planner's note: the error type is public API",
      confirming: true,
      files: 4,
    };
    expect(resultMenuHeight(asking, 120)).toBe(
      stopMenuLayout(resultMenuRows(asking), 120).height + 2,
    );
    const menu = { ...asking, confirming: false };
    expect(resultMenuHeight(menu, 120)).toBe(stopMenuLayout(resultMenuRows(menu), 120).height);
  });

  it('adds every wrapped row of a long note while it asks', () => {
    const note = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const asking = { override: true, findings: ['one', 'two'], note, confirming: true, files: 4 };
    const noteRows = resultMenuNoteLines(note, 80).length;
    expect(noteRows).toBeGreaterThan(1);
    expect(resultMenuHeight(asking, 80)).toBe(
      stopMenuLayout(resultMenuRows(asking), 80).height + noteRows + 2,
    );
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

  it.each([
    {
      redChecks: [V1],
      findings: ['missing null check', 'stale doc'],
      files: 4,
      title: 'Ready to apply as is · 1 red check · 2 open findings · 4 files changed',
    },
    {
      redChecks: [V1],
      findings: [],
      files: 4,
      title: 'Ready to apply as is · 1 red check · 4 files changed',
    },
    {
      redChecks: [V1, K004],
      findings: ['missing null check'],
      files: null,
      title: 'Ready to apply as is · 2 red checks · 1 open finding',
    },
  ])('counts the red checks of an override first: $title', ({ title, ...input }) => {
    expect(resultMenuTitle({ override: true, confirming: false, ...input })).toBe(title);
  });

  it.each([
    {
      redChecks: [V1],
      findings: ['missing null check', 'stale doc'],
      title: 'Apply with 1 red check and 2 open findings?',
    },
    { redChecks: [V1], findings: [], title: 'Apply with 1 red check?' },
    {
      redChecks: [V1, K004],
      findings: ['missing null check'],
      title: 'Apply with 2 red checks and 1 open finding?',
    },
  ])('asks the confirmation with the red checks first: $title', ({ title, ...input }) => {
    expect(titleParts({ override: true, confirming: true, files: 4, ...input })).toEqual([
      { text: title, tone: 'warning' },
    ]);
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
