import { beforeAll, describe, it } from 'vitest';
import { RELEASE_MATRIX, resolveReleaseMatrixRun } from '../../live/matrix.js';
import { beginLiveManifest, runReleaseMatrixRow } from '../../helpers/live-harness.js';

const releaseLiveOn = process.env.SPLITBRIEF_RELEASE_LIVE === '1';
const itRelease = releaseLiveOn ? it : it.skip;
if (!releaseLiveOn) console.log('skipped: SPLITBRIEF_RELEASE_LIVE not set');

describe('live release matrix', () => {
  if (releaseLiveOn) {
    beforeAll(() => {
      beginLiveManifest();
    });
  }

  for (const row of RELEASE_MATRIX) {
    itRelease(
      `release row ${row.id}: ${row.mode}, plan ${row.plan}, build ${row.build}` +
        (row.review === undefined ? '' : `, review ${row.review}`),
      async (ctx) => {
        const result = await runReleaseMatrixRow(resolveReleaseMatrixRun(row));
        if (result.outcome === 'skip') return ctx.skip(result.reason ?? 'row skipped');
      },
      row.mode === 'quick' ? 300_000 : 900_000,
    );
  }
});
