import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import {
  SESSION_LOG_FILE,
  SPLITBRIEF_DIR,
  STATE_FILE,
  SUMMARY_FILE,
  sessionDir,
} from '../../../src/core/paths.js';
import { saveSummary } from '../../../src/core/sessions/io.js';
import { readSessionDraft, writeSessionDraft } from '../../../src/core/sessions/draft.js';
import { toEngineEventEntry } from '../../../src/core/sessions/log/writer.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import {
  FIX_CYCLE_RUN_FEATURE,
  fixCycleRun,
  fixCycleRunLog,
} from '#testing/helpers/factories/fix-cycle-run.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { acrossNoticeEdges } from '#testing/helpers/notice-text.js';
import { finding, makeVerdict } from '#testing/helpers/review-verdict.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openClosedRun, type ClosedRunScreen } from '../helpers/closed-run-screen.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const AT = '2026-09-14T09:41:00.000Z';
const SESSION = 'closed-summary';
const CTRL_A = '\u0001';
const WHEEL_UP = '\u001b[<64;40;20M';
const WHEEL_DOWN = '\u001b[<65;40;20M';
const SHIFT_UP = '\u001b[1;2A';
const SHIFT_DOWN = '\u001b[1;2B';

/** A click on column `x` of row `y`, both from 1. */
function click(x: number, y: number): string {
  return `\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`;
}

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/** A long applied run: 15 briefs, 65 changed files and three failed reviews before the pass. */
function seedAppliedRun(
  target: StopContinueFixture,
  sessionId = SESSION,
  feature = FIX_CYCLE_RUN_FEATURE,
): void {
  const ref = { projectDir: target.projectDir, sessionId };
  const run = fixCycleRun(sessionId);
  saveState(ref, { ...run.state, feature });
  saveSummary(ref, {
    id: sessionId,
    feature,
    startedAt: Date.parse(AT),
    completedAt: Date.parse(AT),
    stateVersion: 1,
    status: 'complete',
    summary: run.summary,
  });
  writeEvidenceLedger(ref, run.ledger);
  writeFileSync(
    join(sessionDir(target.projectDir, sessionId), SESSION_LOG_FILE),
    fixCycleRunLog()
      .map((event) => `${JSON.stringify(toEngineEventEntry(event))}\n`)
      .join(''),
  );
}

function addOldAccounting(target: StopContinueFixture): void {
  const dir = sessionDir(target.projectDir, SESSION);
  const tokenUsage = {
    plannerInput: 120,
    plannerOutput: 30,
    implementerInput: 40,
    implementerOutput: 10,
    escalationInput: 0,
    escalationOutput: 0,
  };
  const brief = {
    taskId: 'T001',
    taskTitle:
      'Make drift_report rowless and remove the Drift row code, tests, and gallery fixtures',
    method: 'local',
    retryCount: 0,
    tool: 'command-code',
    model: 'deepseek/deepseek-v4.1-flash-fast',
    kind: 'cli',
    implementerTokens: 50,
    escalationTokens: 0,
    cost: 0.01,
  };
  const statePath = join(dir, STATE_FILE);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...state, tokenUsage, taskBreakdowns: [brief] }));
  const summaryPath = join(dir, SUMMARY_FILE);
  const stored = JSON.parse(readFileSync(summaryPath, 'utf8'));
  writeFileSync(
    summaryPath,
    JSON.stringify({
      ...stored,
      summary: {
        ...stored.summary,
        tokenUsage,
        taskBreakdown: [brief],
        costBreakdown: { actualPlannerCost: 0, actualImplementerCost: 0.01, totalActualCost: 0.01 },
      },
    }),
  );
  const logPath = join(dir, SESSION_LOG_FILE);
  const context = { callId: 'old-build', role: 'implementer', backendKind: 'cli', sequence: 1 };
  const oldEvents = {
    cost_update: { tokenUsage },
    runner_call_usage: {
      ...context,
      usage: { inputTokens: 40, outputTokens: 10 },
      semantics: 'final',
    },
    task_tokens: brief,
  };
  const oldLog = Object.entries(oldEvents)
    .map(([type, data]) =>
      JSON.stringify({ kind: 'event', type, data, ts: AT, phase: 'implementing' }),
    )
    .join('\n');
  const log = readFileSync(logPath, 'utf8');
  writeFileSync(logPath, `${oldLog}\n${log}`);
}

/** The stdin reads of the CLI, one line of its key log for each read. */
function stdinReads(target: StopContinueFixture): string[] {
  const dir = join(target.projectDir, SPLITBRIEF_DIR, 'debug');
  return readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('RAW ')),
  );
}

type AppliedRunScreen = ClosedRunScreen & {
  /** Waits until the key log shows that the CLI got `bytes` in one stdin read. */
  waitForOneRead: (bytes: string) => Promise<void>;
};

/** Opens the seeded run from the sessions list, as a user does, and hands its screen to `read`. */
async function openAppliedRun<T>(
  viewport: { cols: number; rows: number },
  read: (run: AppliedRunScreen) => Promise<T>,
  seed: (target: StopContinueFixture) => void = seedAppliedRun,
): Promise<T> {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  seed(target);
  const home = join(target.tmpDir, 'home');
  mkdirSync(home);
  return openClosedRun(
    {
      argv: ['dist/cli.js', '--project', target.projectDir],
      env: {
        ...safeChildEnvironment(home),
        XDG_STATE_HOME: target.stateHome,
        SPLITBRIEF_DEBUG_KEYS: '1',
      },
      viewport,
    },
    async (run) => {
      await run.waitForText('● Applied to your checkout');
      return read({
        ...run,
        waitForOneRead: async (bytes) => {
          await vi.waitFor(
            () =>
              expect(stdinReads(target)).toContainEqual(
                expect.stringContaining(bytes.replaceAll('\u001b', '\\x1b')),
              ),
            { timeout: 30_000 },
          );
        },
      });
    },
  );
}

it('opens a run saved with accounting fields and shows its seats and briefs', async () => {
  const opened = await openAppliedRun(
    { cols: 160, rows: 45 },
    async ({ screen, write, waitForText }) => {
      write(CTRL_A);
      await waitForText('T001 Make drift_report rowless', '├ collapse · ctrl+a');
      return screen();
    },
    (target) => {
      seedAppliedRun(target);
      addOldAccounting(target);
    },
  );

  expect(opened).toContain('Opus 5.5');
  expect(opened).toContain('DeepSeek V4.1 Flash');
  expect(opened).toContain('T001 Make drift_report rowless');
});

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
  expect(folded).toContain('Briefs 15/15');
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

it('keeps Session at the seven-row boundary when the closed header shows the crew', async () => {
  const frame = await openAppliedRun({ cols: 80, rows: 15 }, async ({ screen }) => screen());

  expect(frame.split('\n')[0]).toContain('PLAN claude · BUILD cmd · REVIEW claude');
  expect(frame).toContain('└ Session  closed-summary');
});

it('shows a short draft-removal notice and the full transcript message when you open another run', async () => {
  const draft = createDraftDocument('old unsent words');
  await openAppliedRun(
    { cols: 120, rows: 40 },
    async ({ screen, write, waitForText, waitForNoText }) => {
      if (fixture === undefined) throw new Error('Expected the applied run fixture.');
      const ref = { projectDir: fixture.projectDir, sessionId: SESSION };
      const dir = sessionDir(ref.projectDir, ref.sessionId);
      seedAppliedRun(fixture, 'other-run', 'Open another run');
      await waitForText('old unsent words');
      chmodSync(dir, 0o555);
      try {
        write('\x15');
        await waitForNoText('old unsent words');
        write('/sessions');
        await waitForText('Browse past sessions');
        write(PTY_SUBMIT_INPUT);
        await waitForText('Sessions · 2', 'Open another run');
        write('Open another run');
        await waitForText('› Open another run');
        write(PTY_SUBMIT_INPUT);
        await waitForText('Session  other-run', 'Could not remove the old draft');
        const rows = screen().split('\n');
        expect(rows.filter((row) => row.includes('permission denied'))).toHaveLength(1);
        expect(acrossNoticeEdges(rows.join('\n'))).toContain(
          'its text comes back when you restart SPLITBRIEF and open that run',
        );
        expect(rows.some((row) => /✗ Could not remove the old draft\s*[│▐]?\s*$/u.test(row))).toBe(
          true,
        );
        expect(readSessionDraft(ref)).toEqual(draft);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
    (target) => {
      seedAppliedRun(target);
      writeSessionDraft({ projectDir: target.projectDir, sessionId: SESSION }, draft);
    },
  );
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

// Sixty keys of one read, one turn each, pass the limit of nested React updates unless each turn
// ends in a transition. The wheel steps of one read share one turn.
it.each([
  ['wheel steps', WHEEL_UP, WHEEL_DOWN],
  ['Shift+↑ keys', SHIFT_UP, SHIFT_DOWN],
])(
  'scrolls a long applied run by 60 %s of one read and keeps taking input',
  async (_label, up, down) => {
    const { scrolledAbove, after } = await openAppliedRun(
      { cols: 160, rows: 45 },
      async ({ screen, write, waitForText, waitForOneRead }) => {
        write(up.repeat(60));
        await waitForOneRead(up.repeat(60));
        await waitForText('60 lines below');
        const scrolledAbove = Number(/(\d+) lines above/u.exec(screen())?.[1]);
        write(down);
        await waitForText('59 lines below');
        return { scrolledAbove, after: screen() };
      },
    );

    expect(scrolledAbove).toBeGreaterThan(0);
    expect(after).toContain(` ${scrolledAbove + 1} lines above`);
  },
);

it('opens no fold for a wheel step and a click of one write on the row that the fold reaches', async () => {
  const clicked = await openAppliedRun(
    { cols: 160, rows: 45 },
    async ({ screen, write, waitForText, waitForOneRead }) => {
      const lines = screen().split('\n');
      const index = lines.findIndex((line) => line.includes('+15 briefs'));
      const x = (lines[index]?.indexOf('+15 briefs') ?? 0) + 1;
      const y = index + 1;
      expect(lines[index + 1]).toContain('└ Session');

      write(WHEEL_UP + click(x, y + 1));
      write(WHEEL_UP);
      await waitForOneRead(WHEEL_UP + click(x, y + 1));
      await vi.waitFor(() => expect(screen()).toMatch(/2 lines below|collapse/u), {
        timeout: 30_000,
      });
      expect(screen()).toContain('2 lines below');
      expect(screen()).not.toContain('collapse');

      // One step down puts the fold back on the clicked row, and a click there opens it.
      write(WHEEL_DOWN);
      await waitForText('1 line below');
      write(click(x, y + 1));
      await waitForText('collapse');
      return screen();
    },
  );

  expect(clicked).toContain('├ collapse · ctrl+a');
});

it('shows Briefs and a short saved check finding when reopening a run ended after a failed review', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  const ref = { projectDir: target.projectDir, sessionId: SESSION };
  const blocker = finding({
    severity: 'blocking',
    text: [
      'Reviewer check V1 (npm test) failed and SPLITBRIEF could not verify its run base re-run (the run base re-run timed out); the reviewer decides. Last changed by T001.',
      'check V1 did not pass (fail): 1 failure',
      'Output tail:',
      'Empty addresses bypass validation.',
    ].join('\n'),
  });
  const state = makeWorkflowState({
    feature: 'Validate addresses',
    phase: 'complete',
    startedAt: AT,
    tasks: [makeTask({ title: 'Validate addresses', status: 'done' })],
    reviewStatus: 'failed',
    review: {
      at: AT,
      scope: 'final',
      cycle: 0,
      outcome: 'fail',
      verification: [],
      verdict: makeVerdict({
        findings: [blocker, finding({ id: 'F2', severity: 'minor', text: 'Add an example.' })],
      }),
    },
    closed: { as: 'ended', at: AT },
  });
  saveState(ref, state);
  saveSummary(ref, {
    id: SESSION,
    feature: state.feature,
    startedAt: Date.parse(AT),
    completedAt: Date.parse(AT),
    stateVersion: state.stateVersion,
    status: 'complete',
    summary: makeSummary({
      feature: state.feature,
      totalTasks: 1,
      completedByLocal: 1,
      changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      reviewPacket: {
        generatedAt: AT,
        jsonPath: 'review-packet.json',
        markdownPath: 'review-packet.md',
        finalReviewStatus: 'written',
        finalReviewVerdict: 'fail',
        finalReviewFindingCounts: { critical: 1, warning: 1, note: 0 },
        driftPassed: true,
        evidenceValidatedTasks: 1,
        evidenceTotalTasks: 1,
        missingArtifactCount: 0,
      },
    }),
  });
  const home = join(target.tmpDir, 'home');
  mkdirSync(home);
  const frame = await openClosedRun(
    {
      argv: ['--import', 'tsx', 'src/cli.ts', '--project', target.projectDir],
      env: { ...safeChildEnvironment(home), XDG_STATE_HOME: target.stateHome },
      viewport: { cols: 160, rows: 45 },
      settledText: '1 blocking',
    },
    async ({ screen }) => screen(),
  );
  expect.soft(frame).toContain('Briefs 1/1');
  const review = frame.slice(frame.indexOf('├ Review'));
  expect(acrossNoticeEdges(review)).toContain(
    'npm test failed · 1 failure. Could not verify the failure at the run base (the run base re-run timed out). Last changed by T001.',
  );
  expect(review).not.toContain('Output tail:');
  const narrow = await openClosedRun(
    {
      argv: ['dist/cli.js', '--project', target.projectDir],
      env: { ...safeChildEnvironment(home), XDG_STATE_HOME: target.stateHome },
      viewport: { cols: 60, rows: 18 },
      settledText: '1 blocking',
    },
    async ({ screen }) => screen(),
  );
  expect(narrow.split('\n').find((line) => line.includes('+1 brief'))).toMatch(
    /\+1 brief · 1 blocking finding.*ctrl\+a/,
  );
});
