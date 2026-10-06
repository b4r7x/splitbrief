import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runFixtureRow } from '../../helpers/live-cli-harness.js';
import {
  appendLiveManifestRow,
  beginLiveManifest,
  copyLiveArtifacts,
  gateLiveMatrixRow,
} from '../../helpers/live-harness.js';
import {
  assertFixtureQuality,
  assertPlainStdout,
  assertSessionDir,
  assertWorkingTree,
} from '../../helpers/run-dir-assertions.js';
import { FIXTURE_ROWS, resolveFixtureRowSeats } from '../../live/fixture-rows.js';

const fixtureLiveOn =
  process.env.SPLITBRIEF_REAL_CLI_E2E === '1' && process.env.SPLITBRIEF_LIVE_FIXTURE === '1';
const itFixture = fixtureLiveOn ? it : it.skip;
if (!fixtureLiveOn) {
  console.log('skipped: SPLITBRIEF_REAL_CLI_E2E=1 and SPLITBRIEF_LIVE_FIXTURE=1 are not both set');
}

describe('live fixture loop', () => {
  if (fixtureLiveOn) {
    beforeAll(() => {
      beginLiveManifest();
    });
  }

  for (const row of FIXTURE_ROWS) {
    itFixture(
      `fixture row ${row.id}: plan ${row.plan}, build ${row.build}, review ${row.review}`,
      async (ctx) => {
        const seats = resolveFixtureRowSeats(row);
        const startedAt = Date.now();
        const manifestBase = {
          id: row.id,
          plan: seats.plan,
          build: seats.build,
          review: seats.review,
        };
        const gate = await gateLiveMatrixRow([row.plan, row.build, row.review]);
        if (gate.kind === 'skip') {
          appendLiveManifestRow({
            ...manifestBase,
            outcome: 'skip',
            reason: gate.reason,
            durationMs: Date.now() - startedAt,
          });
          return ctx.skip(gate.reason);
        }

        const run = await runFixtureRow(row);
        try {
          expect(run.exitCode).toBe(0);
          expect(run.stderr).not.toMatch(/Run readiness blocked|BLOCKED:/);
          const completed = assertPlainStdout(run.stdout);
          const facts = assertSessionDir(run.sessionDir, {
            expectedBriefs: row.expectedBriefs,
            completed,
          });
          await assertFixtureQuality(run.projectDir);
          assertWorkingTree(run.projectDir, facts.tasks);
          appendLiveManifestRow({
            ...manifestBase,
            outcome: 'pass',
            durationMs: run.durationMs,
            calls: facts.calls,
            briefs: facts.perBrief,
            artifacts: copyLiveArtifacts({
              projectDir: run.projectDir,
              sessionId: basename(run.sessionDir),
              rowId: row.id,
            }),
          });
        } catch (error) {
          appendLiveManifestRow({
            ...manifestBase,
            outcome: 'fail',
            reason: error instanceof Error ? error.message : String(error),
            durationMs: run.durationMs,
          });
          throw error;
        } finally {
          rmSync(run.tmpDir, { recursive: true, force: true });
        }
      },
      row.timeoutMs,
    );
  }
});
