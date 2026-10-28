import { describe, it, expect } from 'vitest';
import { checkFailureMark, failureMark, judgeProgress, sameFailure } from './progress.js';

const typeError = checkFailureMark([
  { checkId: 'V1', status: 'fail', failure: { keys: ['src/a.ts(3,1): error TS2322'] } },
]);

describe('failureMark', () => {
  it('takes the failed checks first, then the call outcome, then a blocked question, then the error', () => {
    expect(failureMark({ checks: typeError, callOutcome: 'timeout', error: 'x' })).toEqual([
      { source: 'check V1', keys: ['src/a.ts(3,1): error TS2322'] },
    ]);
    expect(failureMark({ checks: [], callOutcome: 'timeout', error: 'x' })).toEqual([
      { source: 'call timeout', keys: [] },
    ]);
    expect(failureMark({ blocked: { question: 'Which schema?' }, error: 'x' })).toEqual([
      { source: 'blocked', keys: ['Which schema?'] },
    ]);
    expect(failureMark({ error: '\n  still broken\nmore' })).toEqual([
      { source: 'error', keys: ['still broken'] },
    ]);
  });

  it('marks a check that did not fail with its status', () => {
    expect(checkFailureMark([{ checkId: 'V2', status: 'not-runnable' }])).toEqual([
      { source: 'check V2', keys: ['not-runnable'] },
    ]);
  });
});

describe('sameFailure', () => {
  it('is the same failure when the same diagnostic only moved its line', () => {
    const moved = checkFailureMark([
      { checkId: 'V1', status: 'fail', failure: { keys: ['src/a.ts(9,4): error TS2322'] } },
    ]);
    expect(sameFailure(typeError, moved)).toBe(true);
  });

  it('is a moved failure when a key is new, a key is gone, or another check fails', () => {
    const more = checkFailureMark([
      {
        checkId: 'V1',
        status: 'fail',
        failure: { keys: ['src/a.ts(3,1): error TS2322', 'src/b.ts(1,1): error TS2304'] },
      },
    ]);
    const other = checkFailureMark([
      { checkId: 'V2', status: 'fail', failure: { keys: ['src/a.ts(3,1): error TS2322'] } },
    ]);
    expect(sameFailure(typeError, more)).toBe(false);
    expect(sameFailure(more, typeError)).toBe(false);
    expect(sameFailure(typeError, other)).toBe(false);
  });
});

describe('judgeProgress', () => {
  const a = failureMark({ error: 'error A' });
  const b = failureMark({ error: 'error B' });

  it('starts a lineage with its first answer', () => {
    expect(judgeProgress(undefined, a)).toEqual({
      stop: null,
      next: { failure: a, unmoved: 0, answers: 1 },
    });
  });

  it('stops on the second answer in a row that did not move the failure', () => {
    const once = judgeProgress({ failure: a, unmoved: 0, answers: 1 }, a);
    expect(once).toEqual({ stop: null, next: { failure: a, unmoved: 1, answers: 2 } });
    expect(judgeProgress(once.next, a).stop).toBe('no-progress');
  });

  it('a moved failure resets the run of unmoved answers', () => {
    expect(judgeProgress({ failure: a, unmoved: 1, answers: 2 }, b)).toEqual({
      stop: null,
      next: { failure: b, unmoved: 0, answers: 3 },
    });
  });

  it('stops a failure that keeps moving after ten answers', () => {
    expect(judgeProgress({ failure: a, unmoved: 0, answers: 10 }, b).stop).toBe('unconverged');
  });
});
