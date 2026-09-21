import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { briefReviewFingerprint } from './brief-review-gate.js';

describe('briefReviewFingerprint', () => {
  it('fingerprint changes when a second file is declared', () => {
    const single = makeTask({ id: 'T001', file: 'src/a.ts' });
    const pair = makeTask({ id: 'T001', file: 'src/a.ts', files: ['src/a.ts', 'src/a.test.ts'] });

    expect(briefReviewFingerprint([pair], 'body', 'detail')).not.toBe(
      briefReviewFingerprint([single], 'body', 'detail'),
    );
  });

  it('is stable for the same briefs', () => {
    const task = makeTask({ id: 'T001', files: ['src/a.ts', 'src/a.test.ts'] });

    expect(briefReviewFingerprint([task], 'body', 'detail')).toBe(
      briefReviewFingerprint([task], 'body', 'detail'),
    );
  });
});
