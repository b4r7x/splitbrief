import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { createStopContinueFixture, readState } from '../helpers/stop-continue-fixture.js';
import { wholeFrames } from '../helpers/whole-frames.js';

const VIEWPORT = { cols: 120, rows: 40 };
const NONE_ROW = 'Review · none · REVIEW is None, so no seat reviewed this run';
const WORDS = 'also fix the typo';
const REVIEW_REFUSAL = 'Cannot send words to the review. Clear them.';
const APPLY_REFUSAL = 'Cannot send words to Apply. Clear them.';
const NO_WORDS_PLACEHOLDER = '/ for a command…';

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const REVIEW_REPLY = JSON.stringify(
  passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] }),
);

function plannerScript(callsPath: string, reviewHold: string, reviewReply: string): string {
  return `import { appendFileSync, existsSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const kind = prompt.includes('# Final Implementation Review') ? 'final-review' : prompt.includes('# Plan the change') ? 'plan' : 'other';
appendFileSync(${JSON.stringify(callsPath)}, kind + (prompt.includes(${JSON.stringify(WORDS)}) ? ' +words' : '') + '\\n');
if (kind === 'final-review') {
  const deadline = Date.now() + 120000;
  while (existsSync(${JSON.stringify(reviewHold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  process.stdout.write(${JSON.stringify(reviewReply)});
} else {
  if (kind !== 'plan') throw new Error('Unexpected prompt');
  process.stdout.write(JSON.stringify(${JSON.stringify({ result: plan })}));
}
`;
}

function implementerScript(callsPath: string, hold: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, 'export const total = (a, b) => a + b;\\n');
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, "import { strict as assert } from 'node:assert';\\nimport { test } from 'node:test';\\nimport { total } from './total.mjs';\\ntest('t', () => assert.equal(total(1, 2), 3));\\n");
const deadline = Date.now() + 120000;
while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
console.log('Implemented');
`;
}

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

function setup(
  isolation: 'none' | 'worktree',
  reviewer: 'none' | 'seat',
  reviewReply: string = REVIEW_REPLY,
) {
  const target = createStopContinueFixture(() => '', { isolation });
  const calls = join(target.tmpDir, 'calls.txt');
  const hold = join(target.tmpDir, 'hold');
  const reviewHold = join(target.tmpDir, 'review-hold');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(plannerPath, plannerScript(calls, reviewHold, reviewReply));
  writeFileSync(implementerPath, implementerScript(calls, hold));
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('The fixture must declare a shell planner and an agent implementer.');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    ...(reviewer === 'none' && { reviewer: 'none' as const }),
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, testCommand: 'node --test' },
  });
  const callsMade = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { target, calls, callsMade, hold, reviewHold, offlinePath };
}

type Run = ReturnType<typeof setup>;

async function inTui(run: Run, home: string, drive: (tui: Tui) => Promise<void>): Promise<void> {
  const { target, offlinePath } = run;
  const env: Readonly<Record<string, string>> = {
    ...safeChildEnvironment(home),
    XDG_STATE_HOME: target.stateHome,
  };
  await trustDeclaredRunners({
    projectDir: target.projectDir,
    config: loadConfig(target.projectDir).config,
    pathEnv: env.PATH ?? '',
  });
  await runWithPtyChild(
    {
      requirement: 'required',
      argv: [
        '--import',
        'tsx',
        '--import',
        offlinePath,
        'src/cli.ts',
        '--allow-repo-runners',
        '--project',
        target.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...VIEWPORT,
        cwd: resolve(import.meta.dirname, '../../..'),
        env,
      },
    },
    async (child) => {
      const exit = Promise.withResolvers<PtyExitEvent>();
      let outcome: PtyExitEvent | undefined;
      const terminal = new XtermHeadless.Terminal({
        ...VIEWPORT,
        allowProposedApi: true,
        convertEol: true,
        scrollback: 0,
        logLevel: 'off',
      });
      const screen = () =>
        Array.from(
          { length: VIEWPORT.rows },
          (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
        ).join('\n');
      const frames = wholeFrames((data) => terminal.write(data));
      const dataListener = child.onData(frames.feed);
      const exitListener = child.onExit((event) => {
        frames.flush();
        outcome = event;
        exit.resolve(event);
      });
      try {
        await drive({ screen, write: (keys) => child.write(keys) });
      } finally {
        if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
        await reapOrphanRunners(target.projectDir);
        dataListener.dispose();
        exitListener.dispose();
        terminal.dispose();
      }
    },
  );
}

async function startRun({ screen, write }: Tui): Promise<void> {
  await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
  write('add a total helper');
  await expect.poll(screen).toContain('› add a total helper');
  write(PTY_SUBMIT_INPUT);
}

async function pauseAfterLastBrief(tui: Tui, run: Run): Promise<void> {
  const { screen, write } = tui;
  writeFileSync(run.hold, '');
  await startRun(tui);
  await vi.waitFor(() => expect(run.callsMade()).toContain('implement'), { timeout: 120_000 });
  write('\x1b');
  await expect.poll(screen, { timeout: 30_000 }).toContain('Pause after this brief');
  await moveCursorTo(screen, write, '\x1b[B', /▌ Pause after this brief/);
  write('\r');
  await expect.poll(screen, { timeout: 30_000 }).toContain('Pause requested');
  rmSync(run.hold);
  await expect.poll(screen, { timeout: 60_000 }).toContain('⏎ resume');
}

async function refusesWords({ screen, write }: Tui, refusal: string): Promise<void> {
  write(WORDS);
  await expect.poll(screen).toContain(`› ${WORDS}`);
  write(PTY_SUBMIT_INPUT);
  await expect
    .poll(() => {
      const shown = screen();
      return shown.includes(refusal) && shown.includes(`› ${WORDS}`);
    })
    .toBe(true);
  for (let i = 0; i < WORDS.length; i++) write('\x7f');
  await expect.poll(screen).not.toContain(`› ${WORDS}`);
}

async function reopenAtRest(tui: Tui): Promise<void> {
  tui.write('\x1b');
  await expect.poll(tui.screen, { timeout: 60_000 }).toContain('Describe your feature');
  await openFromHome(tui);
}

async function openFromHome({ screen, write }: Tui): Promise<void> {
  write('/sessions');
  await expect.poll(screen).toContain('▌ /sessions');
  write('\r');
  await expect.poll(screen, { timeout: 30_000 }).toMatch(/Sessions · 1/);
  await expect.poll(screen).toMatch(/▌/);
  write('\r');
  await expect.poll(screen, { timeout: 30_000 }).not.toMatch(/Sessions · 1/);
}

async function moveReviewToNone({ screen, write }: Tui, configPath: string): Promise<void> {
  write('/crew');
  await expect.poll(screen).toContain('▌ /crew');
  write('\r');
  await expect.poll(screen).toContain('Settings');
  await moveCursorTo(screen, write, '\x1b[B', /▌ REVIEW/);
  write('\r');
  await expect.poll(screen).toContain('REVIEW · tool, model, effort');
  await moveCursorTo(screen, write, '\x1b[B', /▌ None/);
  write('\r');
  await vi.waitFor(() => expect(readFileSync(configPath, 'utf8')).toMatch(/^reviewer: none$/m), {
    timeout: 10_000,
  });
  await expect.poll(screen).not.toContain('REVIEW · tool, model, effort');
}

function sessionOf(run: Run): string {
  const sessionId = readActive(run.target.projectDir);
  if (sessionId === null) throw new Error('no active session');
  return sessionId;
}

async function finishesWithoutAReview(tui: Tui, run: Run, sessionId: string): Promise<void> {
  tui.write('\r');
  await expect.poll(tui.screen, { timeout: 60_000 }).toContain(NONE_ROW);
  await expect
    .poll(
      () => {
        const state = readState(run.target, sessionId);
        return [state.phase, state.reviewStatus];
      },
      { timeout: 60_000 },
    )
    .toEqual(['complete', 'none']);
}

it('a REVIEW None run on the project checkout reads no words once its last brief is done', {
  timeout: 300_000,
}, async () => {
  const run = setup('none', 'none');
  const trustHome = useTrustHome('review-none-co-last-brief');
  try {
    await inTui(run, trustHome.home, async (tui) => {
      await pauseAfterLastBrief(tui, run);
      await expect.poll(tui.screen).toContain('Stopped before the review · 1 of 1 briefs complete');
      await refusesWords(tui, REVIEW_REFUSAL);
      const sessionId = sessionOf(run);
      expect(readState(run.target, sessionId).interruptedStep).toMatchObject({
        step: { kind: 'review', cycle: 0 },
        cut: 'boundary',
      });

      await reopenAtRest(tui);
      await expect
        .poll(tui.screen, { timeout: 30_000 })
        .toContain('Stopped before the review · ⏎ to continue');
      expect(tui.screen()).toContain(NO_WORDS_PLACEHOLDER);
      expect(tui.screen()).not.toContain('Type a correction');
      await refusesWords(tui, REVIEW_REFUSAL);
      expect(readState(run.target, sessionId).messageQueue).toEqual([]);

      await finishesWithoutAReview(tui, run, sessionId);
    });
    expect(run.callsMade()).toEqual(['plan', 'implement']);
  } finally {
    trustHome.restore();
    cleanupTempDir(run.target.tmpDir);
  }
});

it('a seat run on the project checkout stopped in its review and moved to None reads no words', {
  timeout: 300_000,
}, async () => {
  const run = setup('none', 'seat');
  const trustHome = useTrustHome('review-none-co-moved');
  const configPath = join(run.target.projectDir, SPLITBRIEF_DIR, 'config.yaml');
  try {
    await inTui(run, trustHome.home, async (tui) => {
      const { screen, write } = tui;
      writeFileSync(run.reviewHold, '');
      await startRun(tui);
      await vi.waitFor(() => expect(run.callsMade()).toContain('final-review'), {
        timeout: 120_000,
      });
      write('\x1b');
      await expect.poll(screen, { timeout: 30_000 }).toContain('Stop now');
      await moveCursorTo(screen, write, '\x1b[B', /▌ Stop now/);
      write('\r');
      await expect.poll(screen, { timeout: 60_000 }).toContain('Stopped at the review');
      const sessionId = sessionOf(run);
      await vi.waitFor(
        () =>
          expect(readState(run.target, sessionId).interruptedStep).toMatchObject({
            step: { kind: 'review', cycle: 0 },
            cut: 'mid-step',
          }),
        { timeout: 30_000 },
      );
      await expect.poll(screen, { timeout: 30_000 }).toContain('Session options');

      await moveReviewToNone(tui, configPath);
      write('\x1b');
      await expect.poll(screen, { timeout: 30_000 }).toContain(NO_WORDS_PLACEHOLDER);
      await refusesWords(tui, REVIEW_REFUSAL);

      await reopenAtRest(tui);
      await expect
        .poll(screen, { timeout: 30_000 })
        .toContain('Stopped at the review · ⏎ to continue');
      expect(screen()).toContain(NO_WORDS_PLACEHOLDER);
      expect(screen()).not.toContain('Type a correction');
      await refusesWords(tui, REVIEW_REFUSAL);

      await finishesWithoutAReview(tui, run, sessionId);
    });
    expect(run.callsMade()).toEqual(['plan', 'implement', 'final-review']);
  } finally {
    trustHome.restore();
    cleanupTempDir(run.target.tmpDir);
  }
});

it('a seat run on the project checkout halted in its review and moved to None shows no Apply stage', {
  timeout: 300_000,
}, async () => {
  const run = setup('none', 'seat', 'this is no verdict');
  const trustHome = useTrustHome('review-none-co-halted');
  const configPath = join(run.target.projectDir, SPLITBRIEF_DIR, 'config.yaml');
  try {
    await inTui(run, trustHome.home, async (tui) => {
      const { screen, write } = tui;
      await startRun(tui);
      await expect.poll(screen, { timeout: 120_000 }).toContain('Seat down');
      write('\x1b');
      await expect.poll(screen, { timeout: 30_000 }).toContain('Stop options');
      write('\x1b');
      await expect.poll(screen, { timeout: 30_000 }).toContain('Session options');
      write('\x1b');
      await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
      await moveReviewToNone(tui, configPath);
      write('\x1b');
      await expect.poll(screen, { timeout: 30_000 }).toContain('Describe your feature');
      await openFromHome(tui);
      await expect.poll(screen, { timeout: 30_000 }).toContain('⏎ to decide');

      write('\r');
      await expect.poll(screen, { timeout: 30_000 }).toContain('Choose how to continue');
      await expect.poll(screen).toMatch(/● Build → ✗ Review(?! → )/);
      expect(screen()).not.toMatch(/→ . Apply/);
    });
  } finally {
    trustHome.restore();
    cleanupTempDir(run.target.tmpDir);
  }
});

it('a REVIEW None run on a worktree names Apply at the stop after its last brief and reads no words', {
  timeout: 300_000,
}, async () => {
  const run = setup('worktree', 'none');
  const trustHome = useTrustHome('review-none-co-worktree');
  try {
    await inTui(run, trustHome.home, async (tui) => {
      const { screen } = tui;
      await pauseAfterLastBrief(tui, run);
      await expect.poll(screen).toContain('Stopped at Apply · 1 of 1 briefs complete');
      expect(screen()).toContain('│ Stopped at Apply');
      expect(screen()).not.toContain('Stopped before the review');
      const sessionId = sessionOf(run);
      expect(readState(run.target, sessionId).interruptedStep).toMatchObject({
        step: { kind: 'apply' },
        cut: 'boundary',
      });
      await refusesWords(tui, APPLY_REFUSAL);

      tui.write('\r');
      await expect
        .poll(() => readState(run.target, sessionId).phase, { timeout: 60_000 })
        .toBe('complete');
      await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
    });
    expect(run.callsMade()).toEqual(['plan', 'implement']);
  } finally {
    trustHome.restore();
    cleanupTempDir(run.target.tmpDir);
  }
});
