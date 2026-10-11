import { describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { rowText } from '../row-format/rows.js';
import { wrapWidthFor } from '../row-markers.js';
import { fullSuiteRowBlock } from './execution.js';

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
      name: 'fix check without proof',
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
        ownLeft: 0,
        others: 0,
        proven: false,
        duration: 180_000,
      },
      width: 65,
      expected: [
        'Fix check V2 · npm run test-ci · your 2\u00a0failures not shown ',
        '  not\u00a0proven\u00a0fixed · 3m\u00a00s',
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
        passed: false,
        own: 2,
        ownLeft: 0,
        others: 3,
        proven: true,
        duration: 180_000,
      },
      width: 79,
      expected: [
        'Fix check V2 · npm run test-ci · your 2\u00a0failures gone · 3\u00a0others left ',
        '  3m\u00a00s',
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
  ])('hangs the continuation under its $name', ({ event, width, expected }) => {
    const block = fullSuiteRowBlock('check', event, width);
    if (block === null) throw new Error('Expected a check block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual(expected);
    expect(block.createRows(1, 2).map(rowText)).toEqual(expected.slice(1));
    for (const row of rows) {
      expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(
        wrapWidthFor('message', width),
      );
    }
  });
});
