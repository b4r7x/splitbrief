import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TEST_METADATA } from '#testing/helpers/orchestrator-factories.js';
import { buildSpecFrontmatter } from '../../../core/paths-io.js';
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

  it('ignores the header each write of tasks.md stamps, not the briefs under it', () => {
    const task = makeTask({ id: 'T001' });
    const header = buildSpecFrontmatter(TEST_METADATA);
    const restamped = header.replace(/created_at: .*/, 'created_at: 2099-01-01T00:00:00.000Z');

    expect(restamped).not.toBe(header);
    expect(briefReviewFingerprint([task], `${restamped}body`, 'detail')).toBe(
      briefReviewFingerprint([task], `${header}body`, 'detail'),
    );
    expect(briefReviewFingerprint([task], `${header}edited body`, 'detail')).not.toBe(
      briefReviewFingerprint([task], `${header}body`, 'detail'),
    );
  });
});
