import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import { saveSummary } from '../../../src/core/sessions/io.js';
import { toEngineEventEntry } from '../../../src/core/sessions/log/writer.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  FIX_CYCLE_RUN_FEATURE,
  fixCycleRun,
  fixCycleRunLog,
} from '#testing/helpers/factories/fix-cycle-run.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openClosedRun, type ClosedRunScreen } from '../helpers/closed-run-screen.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const AT = '2026-09-14T09:41:00.000Z';
const SESSION = 'closed-summary';
const CTRL_A = '\u0001';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/** A long applied run: 15 briefs, 65 changed files and three failed reviews before the pass. */
function seedAppliedRun(target: StopContinueFixture): void {
  const ref = { projectDir: target.projectDir, sessionId: SESSION };
  const run = fixCycleRun(SESSION);
  saveState(ref, run.state);
  saveSummary(ref, {
    id: SESSION,
    feature: FIX_CYCLE_RUN_FEATURE,
    startedAt: Date.parse(AT),
    completedAt: Date.parse(AT),
    stateVersion: 1,
    status: 'complete',
    summary: run.summary,
  });
  writeEvidenceLedger(ref, run.ledger);
  writeFileSync(
    join(sessionDir(target.projectDir, SESSION), SESSION_LOG_FILE),
    fixCycleRunLog()
      .map((event) => `${JSON.stringify(toEngineEventEntry(event))}\n`)
      .join(''),
  );
}

/** Opens the seeded run from the sessions list, as a user does, and hands its screen to `read`. */
async function openAppliedRun<T>(
  viewport: { cols: number; rows: number },
  read: (run: ClosedRunScreen) => Promise<T>,
): Promise<T> {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  seedAppliedRun(target);
  const home = join(target.tmpDir, 'home');
  mkdirSync(home);
  return openClosedRun(
    {
      argv: ['dist/cli.js', '--project', target.projectDir],
      env: { ...safeChildEnvironment(home), XDG_STATE_HOME: target.stateHome },
      viewport,
    },
    async (run) => {
      await run.waitForText('● Applied to your checkout');
      return read(run);
    },
  );
}

it('closes the transcript of a long applied run with its summary, and opens the whole record on ctrl+a', async () => {
  const { folded, opened, foldedAgain } = await openAppliedRun(
    { cols: 160, rows: 45 },
    async ({ screen, write, waitForText, waitForNoText }) => {
      await waitForText('Final review after 3 fix cycles passed');
      const folded = screen();
      write(CTRL_A);
      await waitForText('● Applied to your checkout', '├ collapse · ctrl+a', 'T001');
      const opened = screen();
      write(CTRL_A);
      await waitForNoText('├ collapse');
      await waitForText('└ Session  closed-summary');
      return { folded, opened, foldedAgain: screen() };
    },
  );

  // The summary closes the transcript: the last review row of the run stands above it.
  expect(folded).toContain('● Final review after 3 fix cycles passed  1 note · 53m 29s');
  expect(folded).toContain('● Applied to your checkout  65 files · 7h 12m 17s');
  expect(folded).toContain('├ Plan     7 briefs · 6 criteria · 33m 21s');
  expect(folded).toContain(
    '├ Build    15/15 briefs passed · 8 from fix cycles · 2 consulted · 3 retries · 3h 55m 12s',
  );
  // The review row counts its findings in the words of the review row above it.
  expect(folded).toContain('├ Review   pass with notes · 1 note · 6/6 criteria · 2h 43m 44s');
  expect(folded).toContain(
    '│          3 earlier reviews failed (10, 2, 1 blocking) · fixed in 3 fix cycles',
  );
  expect(folded).toContain('├ Files    65 files · 29 test files');
  // The fold counts what it hides: three of the 65 files and the one note are on the screen.
  expect(folded).toContain('├ +15 briefs · 62 files · 3 reviews · ctrl+a');
  // The rule under the transcript says that the run is closed, and when: the day and the time.
  expect(folded).toContain('─ Run closed · Sep 14, 16:54 ─');
  expect(folded).toContain('Tasks 15/15');
  // One row per stage, not one row per brief, per file or per earlier finding.
  expect(folded).not.toContain('Final review failed');
  expect(folded).not.toContain('Packet');
  expect(folded.match(/closed-summary/g)).toHaveLength(1);
  // Only the lowest fold names the key that opens it.
  expect(folded).toMatch(/├ \+2 earlier *$/mu);
  expect(folded.match(/ctrl\+a/g)).toHaveLength(1);

  // ctrl+a opens the lowest fold, the record, and its outcome row stays on the screen.
  expect(opened).toContain('● Applied to your checkout  65 files · 7h 12m 17s');
  expect(opened).toMatch(/│ {10}T001 Make drift_report rowless .*passed · 13m 22s/u);
  expect(opened).not.toMatch(/\+\d+ briefs/u);

  // The fold above the summary is not the lowest one, so both presses leave it folded.
  expect(foldedAgain).toMatch(/├ \+2 earlier *$/mu);
  expect(foldedAgain).toContain('├ +15 briefs · 62 files · 3 reviews · ctrl+a');
  expect(foldedAgain).not.toContain('collapse · ctrl+a');
});

it('keeps the outcome of a long applied run on a short terminal, with one row per label', async () => {
  const short = await openAppliedRun({ cols: 60, rows: 18 }, async ({ screen }) => screen());

  expect(short).toContain('● Applied to your checkout  65 files · 7h 12m 17s');
  expect(short).toContain('├ Review   pass with notes · 1 note · 2h 43m 44s');
  expect(short).toContain('├ Files    65 files · 29 test files');
  // The note and the three lead files left the screen, so the fold counts them too.
  expect(short).toContain('├ +15 briefs · 65 files · 1 note · 3 reviews · ctrl+a');
  expect(short).not.toContain('R1 src/core');
  expect(short).not.toContain('registry.ts');
  expect(short).toContain('─ Run closed · Sep 14, 16:54 ─');
});

it('keeps the outcome and the fold of a long applied run on a very short terminal, and opens the record on ctrl+a', async () => {
  const { folded, opened } = await openAppliedRun(
    { cols: 60, rows: 14 },
    async ({ screen, write, waitForText }) => {
      const folded = screen();
      write(CTRL_A);
      await waitForText('├ collapse · ctrl+a');
      return { folded, opened: screen() };
    },
  );

  // The view is too short for every labelled row: the rows below Files go, the outcome stays,
  // and the fold closes the tree.
  expect(folded).toContain('● Applied to your checkout  65 files · 7h 12m 17s');
  expect(folded).toContain('├ Review   pass with notes · 1 note · 2h 43m 44s');
  expect(folded).toContain('├ Files    65 files · 29 test files');
  expect(folded).toContain('└ +15 briefs · 65 files · 1 note · 3 reviews · ctrl+a');
  expect(folded).not.toContain('Session  closed-summary');
  expect(folded).toContain('─ Run closed · Sep 14, 16:54 ─');

  // ctrl+a opens the whole record under the same outcome row.
  expect(opened).toContain('● Applied to your checkout');
  expect(opened).toContain('├ collapse · ctrl+a');
});
