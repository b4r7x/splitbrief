import { describe, expect, it } from 'vitest';
import { splitFailureAtBase } from './base-gate.js';

const BASE = { head: 'abc123' };

describe('splitFailureAtBase', () => {
  it('marks the keys the same command also shows red at the run base as pre-existing', () => {
    const split = splitFailureAtBase(
      { keys: ['a.test.ts::old', 'a.test.ts::new'] },
      {
        kind: 'ran',
        run: {
          checkId: 'V1',
          status: 'fail',
          output: 'red',
          failure: { keys: ['a.test.ts::old'] },
        },
      },
      BASE,
    );

    expect(split.preExisting).toEqual(['a.test.ts::old']);
    expect(split.notVerified).toBeUndefined();
    expect(split.counts).toEqual({
      newFailures: 1,
      preExisting: 1,
      newKeys: ['a.test.ts::new'],
      preExistingKeys: ['a.test.ts::old'],
    });
  });

  it('leaves every key new when the command passes at the run base', () => {
    const split = splitFailureAtBase(
      { keys: ['a.test.ts::new'] },
      { kind: 'ran', run: { checkId: 'V1', status: 'pass', output: 'ok' } },
      BASE,
    );

    expect(split.preExisting).toEqual([]);
    expect(split.counts).toEqual({
      newFailures: 1,
      preExisting: 0,
      newKeys: ['a.test.ts::new'],
      preExistingKeys: [],
    });
  });

  it('does not verify a red whose keys are a placeholder on both sides', () => {
    const split = splitFailureAtBase(
      { keys: ['timed out'], placeholder: 'timed out' },
      {
        kind: 'ran',
        run: {
          checkId: 'V1',
          status: 'fail',
          output: 'red',
          failure: { keys: ['timed out'], placeholder: 'timed out' },
        },
      },
      BASE,
    );

    expect(split.preExisting).toEqual([]);
    expect(split.notVerified).toBe('both runs timed out');
    expect(split.counts).toEqual({
      newFailures: 0,
      preExisting: 0,
      notVerified: 1,
      detail: 'both runs timed out',
    });
  });
});
