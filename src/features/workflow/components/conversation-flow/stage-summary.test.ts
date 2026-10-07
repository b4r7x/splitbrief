import { describe, expect, it } from 'vitest';
import { stageSummaryRow } from './stage-summary.js';

describe('stageSummaryRow', () => {
  it('names the plan by the run it planned and how long it took', () => {
    expect(
      stageSummaryRow({ stage: 'plan', feature: 'Fix the red tests', duration: 8_000 }),
    ).toEqual({
      id: 'Plan',
      title: 'Fix the red tests',
      state: { kind: 'stage', failed: false, detail: ['8.0s'] },
    });
  });

  it('says what failed in a review cycle and which fix briefs it appended', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        ordinal: 1,
        failedCommands: ['npm test'],
        failedChecks: 1,
        fixes: ['T006', 'T007', 'T008'],
        duration: 2_834_200,
      }),
    ).toEqual({
      id: 'Review 1',
      title: '',
      state: {
        kind: 'stage',
        failed: true,
        detail: ['npm test, 1 check', 'fixes T006 T007 T008', '2834.2s'],
      },
    });
  });

  it('lists every failed suite command and counts the failed checks', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        ordinal: 2,
        failedCommands: ['npm run typecheck', 'npm test'],
        failedChecks: 3,
        fixes: ['T009'],
        duration: 1_000,
      }).state,
    ).toEqual({
      kind: 'stage',
      failed: true,
      detail: ['npm run typecheck, npm test, 3 checks', 'fixes T009', '1.0s'],
    });
  });

  it('reads failed when the review verdict, not a suite stage or a check, sent the run back', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        ordinal: 1,
        failedCommands: [],
        failedChecks: 0,
        fixes: ['T004'],
        duration: 1_000,
      }),
    ).toEqual({
      id: 'Review 1',
      title: '',
      state: { kind: 'stage', failed: true, detail: ['fixes T004', '1.0s'] },
    });
  });

  it('reads passed for a review the build went on from', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        ordinal: 1,
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1_000,
      }),
    ).toEqual({
      id: 'Review 1',
      title: 'passed',
      state: { kind: 'stage', failed: false, detail: ['1.0s'] },
    });
  });
});
