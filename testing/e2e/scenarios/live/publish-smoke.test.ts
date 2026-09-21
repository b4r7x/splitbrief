import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_FILE, SUMMARY_FILE } from '../../../../src/core/paths.js';
import { SessionSchema } from '../../../../src/core/schemas/session.js';
import { parseFinalReview } from '../../../../src/engine/parsers/final-review.js';
import {
  MATRIX_TIERS,
  type ReleaseMatrixRun,
  beginLiveManifest,
  runReleaseMatrixRow,
} from '../../helpers/live-harness.js';

const publishLiveOn = process.env.SPLITBRIEF_PUBLISH_LIVE === '1';
const itPublish = publishLiveOn ? it : it.skip;
if (!publishLiveOn) console.log('skipped: SPLITBRIEF_PUBLISH_LIVE not set');

// The shipped crew, pinned above the live cost ceiling on purpose; the row runs
// only behind SPLITBRIEF_PUBLISH_LIVE, never under the easy/heavy tiers.
const PUBLISH_SMOKE: ReleaseMatrixRun = {
  id: 'publish-smoke-claude-code',
  mode: 'quick',
  task: MATRIX_TIERS.quick.task,
  plan: { tool: 'claude-code', model: 'opus' },
  build: { tool: 'claude-code', model: 'sonnet' },
  review: { tool: 'claude-code', model: 'opus' },
};

const ARTIFACT_DIR = join('.test-artifacts', 'live', PUBLISH_SMOKE.id);

describe('publish smoke: opus plans and reviews, sonnet builds', () => {
  if (publishLiveOn) {
    beforeAll(() => {
      beginLiveManifest();
    });
  }

  itPublish(
    'writes the artifact, passes validation and closes on a passing review',
    async (ctx) => {
      const result = await runReleaseMatrixRow(PUBLISH_SMOKE);
      if (result.outcome === 'skip') return ctx.skip(result.reason ?? 'row skipped');
      const session = SessionSchema.parse(
        JSON.parse(readFileSync(join(ARTIFACT_DIR, SUMMARY_FILE), 'utf-8')),
      );
      expect(session.status).toBe('complete');
      const review = parseFinalReview(readFileSync(join(ARTIFACT_DIR, REVIEW_FILE), 'utf-8'));
      expect(['pass', 'pass_with_notes']).toContain(review.verdict);
    },
    300_000,
  );
});
