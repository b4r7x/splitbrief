import { afterEach, describe, expect, it } from 'vitest';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeSpecFile } from '../paths-io.js';
import { readReviewRecord } from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('readReviewRecord', () => {
  it('returns null only for an absent old-session artifact', () => {
    const ref = setupProject(dirs);
    expect(readReviewRecord(ref)).toBeNull();
  });

  it.each(['', '{', '{}'])('reports a corrupt present typed artifact: %j', (content) => {
    const ref = setupProject(dirs);
    writeSpecFile(ref, 'review.json', content);
    expect(() => readReviewRecord(ref)).toThrow('Invalid typed review');
  });
});
