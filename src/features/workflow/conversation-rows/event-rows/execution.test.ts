import { describe, expect, it } from 'vitest';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { rowText } from '../row-format/rows.js';
import { wrapWidthFor } from '../row-markers.js';
import { fullSuiteRowBlock, implementerDoneRowBlock } from './execution.js';

describe('fullSuiteRowBlock', () => {
  it.each(['pre-review', 'plan', 'brief', 'base'] as const)(
    'paints V2 skipped after V1 failed in a %s check row',
    (moment) => {
      const event: EngineEventOf<'full_suite'> = {
        type: 'full_suite',
        ts: 0,
        phase: 'final-review',
        moment,
        id: 'V2',
        command: 'npm test',
        status: 'not-run',
        detail: 'V1 failed',
        duration: 1_000,
      };
      const block = fullSuiteRowBlock('skipped-check', event, 120);
      if (block === null) throw new Error('Expected a skipped check block');
      const rows = block.createRows(0, block.rowCount);
      const label =
        moment === 'pre-review'
          ? 'Reviewer check'
          : moment === 'plan'
            ? 'Plan check'
            : moment === 'brief'
              ? 'Fix check'
              : 'Base re-run';
      expect(rows.map(rowText)).toEqual([`${label} V2 · npm test · not\u00a0run · V1 failed`]);
      expect(rows.flatMap((row) => row.segments)).toEqual([
        ...(moment === 'pre-review'
          ? [
              { text: 'Reviewer', tone: 'reviewer' },
              { text: ' check V2', tone: 'textDim' },
            ]
          : moment === 'plan'
            ? [
                { text: 'Plan', tone: 'planner' },
                { text: ' check V2', tone: 'textDim' },
              ]
            : [{ text: `${label} V2`, tone: 'textDim' }]),
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'not\u00a0run', tone: 'warning' },
        { text: ' · ', tone: 'textDim' },
        { text: 'V1 failed', tone: 'textDim' },
      ]);
    },
  );

  it('fullSuiteRowBlock keeps a wrapped verdict attached to its check', () => {
    const examples = [
      {
        width: 59,
        id: 'V3',
        command: 'node --test test/member.test.js',
        duration: 100,
        check: 'Reviewer check V3 · node --test test/member.test.js ',
        verdict: '  passed · 0.1s',
      },
      {
        width: 79,
        id: 'V4',
        command: 'node --test test/checkout.test.js test/returns.test.js',
        duration: 200,
        check: 'Reviewer check V4 · node --test test/checkout.test.js test/returns.… ',
        verdict: '  passed · 0.2s',
      },
    ];

    for (const { width, id, command, duration, check, verdict } of examples) {
      const event: EngineEventOf<'full_suite'> = {
        type: 'full_suite',
        ts: 0,
        phase: 'final-review',
        moment: 'pre-review',
        id,
        command,
        status: 'done',
        passed: true,
        duration,
      };
      const block = fullSuiteRowBlock('reviewer-check', event, width);

      expect(block).not.toBeNull();
      if (block === null) throw new Error('Expected a reviewer check block');

      const rows = block.createRows(0, block.rowCount);
      expect(block.rowCount).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows.map(rowText)).toEqual([check, verdict]);
      for (const row of rows) {
        expect(rowText(row).trimStart().startsWith('·')).toBe(false);
        expect(rowText(row).trimEnd().endsWith(' ·')).toBe(false);
        expect(
          row.segments.every(
            (segment) =>
              segment.tone ===
              (segment.text === 'Reviewer'
                ? 'reviewer'
                : segment.text === 'passed'
                  ? 'success'
                  : 'textDim'),
          ),
        ).toBe(true);
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(
          wrapWidthFor('message', width),
        );
      }
      expect(block.createRows(1, 2)).toEqual(rows.slice(1));
      expect(block.createRows(1, 2).map(rowText)).toEqual([verdict]);
    }
  });

  it.each<{
    name: string;
    event: EngineEventOf<'full_suite'>;
    width: number;
    expected: string[];
  }>([
    {
      name: 'refused reviewer check',
      event: {
        type: 'full_suite',
        ts: 0,
        phase: 'final-review',
        moment: 'pre-review',
        id: 'V1',
        command: 'npm run lint',
        status: 'refused',
        detail: 'runs the package script lint, and this run changed package.json',
      },
      width: 79,
      expected: [
        'Reviewer check V1 · npm run lint · refused · runs the package script lint, ',
        '  and this run changed package.json',
      ],
    },
    {
      name: 'fix check with a failure left to a sibling',
      event: {
        type: 'full_suite',
        ts: 0,
        phase: 'implementing',
        moment: 'brief',
        id: 'V2',
        command: 'npm run test-ci',
        status: 'done',
        passed: false,
        own: 2,
        ownLeft: 1,
        deferred: 1,
        deferredTo: ['T025'],
        others: 0,
        duration: 180_000,
      },
      width: 65,
      expected: [
        'Fix check V2 · npm run test-ci · 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0remains ',
        '  1\u00a0left\u00a0to\u00a0T025 · 3m\u00a00s',
      ],
    },
    {
      name: 'fix check with other failures',
      event: {
        type: 'full_suite',
        ts: 0,
        phase: 'implementing',
        moment: 'brief',
        id: 'V2',
        command: 'npm run test-ci',
        status: 'done',
        passed: true,
        own: 2,
        ownLeft: 0,
        others: 3,
        duration: 180_000,
      },
      width: 79,
      expected: [
        'Fix check V2 · npm run test-ci · your\u00a02\u00a0failures\u00a0gone ',
        '  3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 3m\u00a00s',
      ],
    },
    {
      name: 'base re-run',
      event: {
        type: 'full_suite',
        ts: 0,
        phase: 'final-review',
        moment: 'base',
        id: 'V2',
        command: 'npm run test-ci',
        status: 'done',
        passed: true,
        duration: 180_000,
      },
      width: 65,
      expected: ['Base re-run V2 · npm run test-ci · passes at the run base ', '  3m\u00a00s'],
    },
    {
      name: 'base re-run with its failing tests',
      event: {
        type: 'full_suite',
        ts: 0,
        phase: 'final-review',
        moment: 'base',
        id: 'V2',
        command: 'npm run test-ci',
        status: 'done',
        passed: false,
        newFailures: 0,
        preExisting: 1,
        preExistingKeys: ['legacy/report-suite.mjs::legacy report > total matches the ledger'],
        duration: 2_000,
      },
      width: 65,
      expected: [
        'Base re-run V2 · npm run test-ci · pre-existing · 2.0s · the ',
        "  failure also fails before this run's changes",
        '  pre-existing · legacy/report-suite.mjs::legacy report > ',
        '                 total matches the ledger',
      ],
    },
  ])('hangs the continuation under its $name', ({ event, width, expected }) => {
    const block = fullSuiteRowBlock('check', event, width);
    if (block === null) throw new Error('Expected a check block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual(expected);
    expect(block.createRows(1, 2).map(rowText)).toEqual(expected.slice(1, 2));
    for (const row of rows) {
      expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(
        wrapWidthFor('message', width),
      );
    }
  });
});

function linesFor(
  overrides: Partial<EngineEventOf<'implementer_generate_done'>>,
  width = 120,
  expanded = false,
): string[] {
  const event = {
    type: 'implementer_generate_done' as const,
    ts: 0,
    phase: 'implementing' as const,
    taskId: taskId('T001'),
    file: 'src/text.js',
    duration: 15_400,
    ...overrides,
  };
  const block = implementerDoneRowBlock(
    'done',
    event,
    { width, viewportRows: 24, streaming: { taskId: null, lines: [], active: false } },
    expanded,
  );
  return block?.createRows(0, block.rowCount).map((row) => rowText(row).trimEnd()) ?? [];
}

describe('implementerDoneRowBlock', () => {
  it.each([undefined, { linesAdded: 12, linesRemoved: 0 }])(
    'lists both changed files once with line counts %j',
    (counts) => {
      expect(linesFor({ files: ['src/text.js', 'test/text.test.js'], ...counts })).toEqual([
        `src/text.js · test/text.test.js${counts === undefined ? '' : '  +12 -0'}`,
      ]);
    },
  );

  it.each([false, true])('labels the diff with both files when expanded=%s', (expanded) => {
    const lines = linesFor(
      {
        files: ['src/text.js', 'test/text.test.js'],
        diff: '+ added',
        linesAdded: 1,
        linesRemoved: 0,
      },
      120,
      expanded,
    );
    expect(lines[0]).toBe(`src/text.js · test/text.test.js  +1 -0${expanded ? '' : '  ctrl+d'}`);
    const text = lines.join('\n');
    for (const value of ['src/text.js', 'test/text.test.js', 'ctrl+d']) {
      expect(text.split(value)).toHaveLength(2);
    }
    if (expanded) expect(text).toContain('ctrl+d to collapse');
  });

  it('keeps the verification verdict under the brief target when no files changed', () => {
    expect(linesFor({ files: [], noChange: true, linesAdded: 0, linesRemoved: 0 })).toEqual([
      'src/text.js',
      'verified · no change needed',
    ]);
  });

  // In a real run, a brief continued after a stop verified the two files it had written before
  // the stop. Its row named one file under the implementer's `2 files` report, as if this call
  // had made the edits.
  it('names every kept file when a continued call verified the work and changed nothing', () => {
    expect(
      linesFor({ files: [], noChange: true, kept: ['src/text.js', 'test/text.test.js'] }),
    ).toEqual([
      'src/text.js · test/text.test.js',
      "verified · kept the interrupted attempt's work · no further change",
    ]);
  });

  it.each([false, true])(
    'names only the kept files the continued call did not change again, expanded=%s',
    (expanded) => {
      const lines = linesFor(
        {
          files: ['src/text.js'],
          diff: '+ added',
          linesAdded: 1,
          linesRemoved: 0,
          kept: ['src/text.js', 'test/text.test.js'],
        },
        120,
        expanded,
      );
      expect(lines[0]).toBe(`src/text.js  +1 -0${expanded ? '' : '  ctrl+d'}`);
      expect(lines.at(-1)).toBe("kept the interrupted attempt's work · test/text.test.js");
      const text = lines.join('\n');
      for (const file of ['src/text.js', 'test/text.test.js']) {
        expect(text.split(file)).toHaveLength(2);
      }
    },
  );

  it('says the work was kept without a file list when the call changed every kept file', () => {
    expect(linesFor({ files: ['src/text.js'], kept: ['src/text.js'] })).toEqual([
      'src/text.js',
      "kept the interrupted attempt's work",
    ]);
  });

  it('replays an older event with its file once', () => {
    expect(linesFor({})).toEqual(['src/text.js']);
  });

  it('shows no disclosure hint for an empty diff', () => {
    expect(linesFor({ files: ['src/text.js', 'test/text.test.js'], diff: '\n\n' })).toEqual([
      'src/text.js · test/text.test.js',
    ]);
  });

  it('wraps a path with spaces as one file name', () => {
    const files = ['src/text.js', 'test/a long directory with spaces/text.test.js'];
    const lines = linesFor({ files }, 60);
    expect(lines).toEqual(['src/text.js', 'test/a long directory with spaces/text.test.js']);
  });

  it.each([120, 80, 60])('keeps whole file names at %s columns', (width) => {
    const files = ['src/features/reporting/text.js', 'test/features/reporting/text.test.js'];
    for (const expanded of [false, true]) {
      const lines = linesFor(
        { files, diff: '+ added', linesAdded: 12, linesRemoved: 0 },
        width,
        expanded,
      );
      const text = lines.join('\n');
      for (const file of files) {
        expect(lines.filter((line) => line.includes(file))).toHaveLength(1);
        expect(text.split(file)).toHaveLength(2);
      }
      expect(lines.every((line) => getTerminalCellWidth(line) <= width - 3)).toBe(true);
      expect(lines.every((line) => !/^\s*·|·\s*$/u.test(line))).toBe(true);
    }
  });
});
