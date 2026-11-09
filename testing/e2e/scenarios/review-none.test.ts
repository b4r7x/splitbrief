import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { fixCyclesOf } from '../../../src/core/schemas/workflow.js';
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
import {
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const NONE_ROW = 'Review · none · REVIEW is None, so no seat reviewed this run';

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_BASE_SOURCE =
  '// total helper\n// adds two numbers\nexport const total = (a, b) => a - b;\n// two arguments\n// end\n';
const TOTAL_CHECKOUT_SOURCE =
  '// total helper\n// adds two numbers\nexport const total = (x, y) => x - y;\n// two arguments\n// end\n';
const TOTAL_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', () => {
  assert.equal(total(1, 2), 3);
});
`;

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

/** The planner answers the plan, and the final review only when `review` is a reply. */
function plannerScript(
  callsPath: string,
  reviewPromptsPath: string,
  review: string | null,
): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const kind = prompt.includes('# Final Implementation Review')
  ? 'final-review'
  : prompt.includes('# Plan the change')
    ? 'plan'
    : 'other';
appendFileSync(${JSON.stringify(callsPath)}, kind + '\\n');
if (kind === 'final-review') appendFileSync(${JSON.stringify(reviewPromptsPath)}, prompt);
const review = ${JSON.stringify(review)};
if (kind === 'final-review' && review !== null) {
  process.stdout.write(review);
} else {
  if (kind !== 'plan') throw new Error('Unexpected prompt: ' + prompt);
  process.stdout.write(JSON.stringify(${JSON.stringify({ result: plan })}));
}
`;
}

type Written = Readonly<{ source: string; test: string }>;

function implementerScript(callsPath: string, written: Written): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const title = Buffer.concat(chunks).toString('utf8').match(/^## Task: (.+)$/m)?.[1];
appendFileSync(${JSON.stringify(callsPath)}, 'implement ' + title + '\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(written.source)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(written.test)});
console.log('Implemented ' + title);
`;
}

/** The test of `total` holds while `hold` exists and `release` does not, so a check can be caught mid-run. */
function heldTotalTest(hold: string, release: string): string {
  return `import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', async () => {
  const deadline = Date.now() + 120_000;
  while (existsSync(${JSON.stringify(hold)}) && !existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(total(1, 2), 3);
});
`;
}

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

/** Writes the fake tools and the config of a run, and returns the file the tools log their calls in. */
function prepareRun(
  target: StopContinueFixture,
  review: string | null,
  written: Written = { source: TOTAL_SOURCE, test: TOTAL_TEST_SOURCE },
) {
  const callsPath = join(target.tmpDir, 'calls.txt');
  const reviewPromptsPath = join(target.tmpDir, 'review-prompts.txt');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(callsPath, '');
  writeFileSync(reviewPromptsPath, '');
  writeFileSync(plannerPath, plannerScript(callsPath, reviewPromptsPath, review));
  writeFileSync(implementerPath, implementerScript(callsPath, written));
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in REVIEW None E2E'); };\n",
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, testCommand: 'node --test' },
  });
  return { callsPath, reviewPromptsPath, offlinePath };
}

/** Commits the total module and prepares a run whose merge with `checkoutSource` is clean and touches the same file. */
function prepareChangedMerge(target: StopContinueFixture, review: string | null) {
  const comments = '// total helper\n// adds two numbers\n// two arguments\n';
  mkdirSync(join(target.projectDir, 'src'), { recursive: true });
  writeFileSync(
    join(target.projectDir, TOTAL_FILE),
    `export const total = (a, b) => a - b;\n${comments}// end\n`,
  );
  execFileSync('git', ['add', TOTAL_FILE], { cwd: target.projectDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'add the total module'], {
    cwd: target.projectDir,
  });
  const hold = join(target.tmpDir, 'hold');
  const release = join(target.tmpDir, 'release');
  const run = prepareRun(target, review, {
    source: `export const total = (a, b) => a + b;\n${comments}// end\n`,
    test: heldTotalTest(hold, release),
  });
  return {
    ...run,
    hold,
    release,
    checkoutSource: `export const total = (a, b) => a - b;\n${comments}// the end\n`,
  };
}

const REVIEW_MOVE = {
  none: { key: '\x1b[B', row: /▌ None/, saved: true },
  plan: { key: '\x1b[A', row: /▌ = PLAN/, saved: false },
} as const;

/** Moves REVIEW in Settings › Crew, waits for the saved config, and closes Settings. */
async function moveReview(
  { screen, write }: Tui,
  target: StopContinueFixture,
  to: keyof typeof REVIEW_MOVE,
): Promise<void> {
  const configPath = join(target.projectDir, SPLITBRIEF_DIR, 'config.yaml');
  write('/crew');
  await expect.poll(screen).toContain('▌ /crew  Who fills each seat');
  write('\r');
  await expect.poll(screen).toContain('Settings');
  await moveCursorTo(screen, write, '\x1b[B', /▌ REVIEW/);
  write('\r');
  await expect.poll(screen).toContain('REVIEW · tool, model, effort');
  await moveCursorTo(screen, write, REVIEW_MOVE[to].key, REVIEW_MOVE[to].row);
  write('\r');
  await vi.waitFor(
    () =>
      expect(/^reviewer: none$/m.test(readFileSync(configPath, 'utf8'))).toBe(
        REVIEW_MOVE[to].saved,
      ),
    { timeout: 10_000 },
  );
  await expect.poll(screen).not.toContain('REVIEW · tool, model, effort');
  write('\x1b');
}

/** Opens the TUI on the project, gives `watch` every painted screen, and closes the TUI after `drive`. */
async function inTui(
  target: StopContinueFixture,
  home: string,
  offlinePath: string,
  watch: (screen: string) => void,
  drive: (tui: Tui) => Promise<void>,
): Promise<void> {
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
      const dataListener = child.onData((data) => terminal.write(data, () => watch(screen())));
      const exitListener = child.onExit((event) => {
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

it('e2e: REVIEW None runs the briefs and ends on one row, and Apply lands the result', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none');
  const hold = join(target.tmpDir, 'hold');
  const release = join(target.tmpDir, 'release');
  const { callsPath, offlinePath } = prepareRun(target, null, {
    source: TOTAL_SOURCE,
    test: heldTotalTest(hold, release),
  });
  let reviewPassedShown = false;
  try {
    await inTui(
      target,
      trustHome.home,
      offlinePath,
      (screen) => {
        if (/review passed/i.test(screen)) reviewPassedShown = true;
      },
      async ({ screen, write }) => {
        await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
        await moveReview({ screen, write }, target, 'none');
        await expect.poll(screen).toContain('Describe your feature');

        writeFileSync(hold, '');
        write('add a total helper');
        await expect.poll(screen).toContain('› add a total helper');
        write(PTY_SUBMIT_INPUT);

        await vi.waitFor(() => expect(readFileSync(callsPath, 'utf8')).toContain('implement'), {
          timeout: 120_000,
        });
        write('\x1b');
        await expect
          .poll(screen, { timeout: 30_000 })
          .toContain(
            'Pause after this brief · finish T001 including checks; do not start another brief',
          );
        expect(screen()).not.toContain('including checks and review');
        write('\t');
        await expect.poll(screen).not.toContain('Pause after this brief');
        writeFileSync(release, '');

        await expect.poll(screen, { timeout: 120_000 }).toContain(NONE_ROW);
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
        await expect.poll(screen, { timeout: 30_000 }).toContain('▌ Apply');
        const sessionId = readActive(target.projectDir);
        if (sessionId === null) throw new Error('no active session');
        write('\r');
        await expect
          .poll(() => readState(target, sessionId).closed?.as, { timeout: 60_000 })
          .toBe('applied');
      },
    );
    expect(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'plan',
      `implement ${brief.title}`,
    ]);
    expect(existsSync(join(target.projectDir, TOTAL_FILE))).toBe(true);
    expect(reviewPassedShown).toBe(false);
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

it('e2e: a move to REVIEW None after a seat reviewed halts Apply on a text conflict and writes no conflict markers', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none-apply');
  mkdirSync(join(target.projectDir, 'src'), { recursive: true });
  writeFileSync(join(target.projectDir, TOTAL_FILE), TOTAL_BASE_SOURCE);
  execFileSync('git', ['add', TOTAL_FILE], { cwd: target.projectDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'add the total module'], {
    cwd: target.projectDir,
  });
  const { callsPath, offlinePath } = prepareRun(target, REVIEW_REPLY);
  let markersShown = false;
  try {
    await inTui(
      target,
      trustHome.home,
      offlinePath,
      (screen) => {
        if (screen.includes('Apply wrote conflict markers')) markersShown = true;
      },
      async ({ screen, write }) => {
        await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
        write('add a total helper');
        await expect.poll(screen).toContain('› add a total helper');
        write(PTY_SUBMIT_INPUT);

        await expect.poll(screen, { timeout: 120_000 }).toContain('Ready to apply');
        await expect.poll(screen, { timeout: 30_000 }).toContain('▌ Apply');
        const sessionId = readActive(target.projectDir);
        if (sessionId === null) throw new Error('no active session');
        writeFileSync(join(target.projectDir, TOTAL_FILE), TOTAL_CHECKOUT_SOURCE);
        writeConfig(target.projectDir, {
          ...loadConfig(target.projectDir).config,
          reviewer: 'none',
        });
        write('\r');
        await expect
          .poll(
            () => {
              const state = readState(target, sessionId);
              return state.pendingRecovery?.reason ?? state.phase;
            },
            { timeout: 60_000 },
          )
          .toBe('apply-conflict');
        await expect.poll(screen, { timeout: 30_000 }).toContain('Apply found 1 conflicting file');
        const { workspace } = readState(target, sessionId);
        if (workspace === undefined || workspace.kind === 'checkout') {
          throw new Error('no run workspace');
        }
        expect(readFileSync(join(workspace.path, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
      },
    );
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_CHECKOUT_SOURCE);
    expect(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'plan',
      `implement ${brief.title}`,
      'final-review',
    ]);
    expect(markersShown).toBe(false);
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

it('e2e: REVIEW None sends a changed merge back to its checks under Apply, and the recheck takes no words', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none-recheck');
  const { callsPath, offlinePath, hold, release, checkoutSource } = prepareChangedMerge(
    target,
    null,
  );
  writeConfig(target.projectDir, { ...loadConfig(target.projectDir).config, reviewer: 'none' });
  const draft = 'also fix the typo';
  try {
    await inTui(
      target,
      trustHome.home,
      offlinePath,
      () => {},
      async ({ screen, write }) => {
        await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
        write('add a total helper');
        await expect.poll(screen).toContain('› add a total helper');
        write(PTY_SUBMIT_INPUT);

        await expect.poll(screen, { timeout: 120_000 }).toContain(NONE_ROW);
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
        await expect.poll(screen, { timeout: 30_000 }).toContain('▌ Apply');
        const sessionId = readActive(target.projectDir);
        if (sessionId === null) throw new Error('no active session');
        const fixCycles = fixCyclesOf(readState(target, sessionId)).used;
        writeFileSync(join(target.projectDir, TOTAL_FILE), checkoutSource);
        write('/run accept');
        await expect.poll(screen).toContain('/run accept');
        write('\r');

        await expect.poll(screen, { timeout: 30_000 }).toContain('needs its checks again');
        await expect.poll(screen).toContain('○ Review → × Apply');
        await expect.poll(screen).toContain('Stopped at Apply · ⏎ to continue');
        await expect.poll(screen).toContain('/ for a command…');

        writeFileSync(hold, '');
        write('\r');
        await expect.poll(screen, { timeout: 30_000 }).toContain('Checking the merged result');
        await expect.poll(screen).toContain('○ Review → ● Apply');
        expect(screen()).not.toContain('Message REVIEW');
        expect(screen()).toContain('/ for a command…');
        expect(screen()).not.toContain('Describe a change…');

        write(draft);
        await expect.poll(screen).toContain(`› ${draft}`);
        write(PTY_SUBMIT_INPUT);
        await expect
          .poll(() => {
            const shown = screen();
            return (
              shown.includes('Cannot send words to Apply. Clear them.') &&
              shown.includes(`› ${draft}`)
            );
          })
          .toBe(true);
        expect(screen()).toContain('Checking the merged result');
        expect(readState(target, sessionId).messageQueue).toEqual([]);

        writeFileSync(release, '');
        await expect
          .poll(
            () => {
              const state = readState(target, sessionId);
              return [state.phase, state.reviewStatus];
            },
            { timeout: 60_000 },
          )
          .toEqual(['complete', 'none']);
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
        expect(screen()).toContain(NONE_ROW);
        expect(fixCyclesOf(readState(target, sessionId)).used).toBe(fixCycles);
      },
    );
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(checkoutSource);
    expect(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'plan',
      `implement ${brief.title}`,
    ]);
  } finally {
    writeFileSync(release, '');
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

it('e2e: a move to REVIEW None at rest stops the run at Apply, refuses words, and runs no new review', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none-move-to-none');
  const { callsPath, offlinePath, hold, release, checkoutSource } = prepareChangedMerge(
    target,
    REVIEW_REPLY,
  );
  const draft = 'also fix the typo';
  try {
    await inTui(
      target,
      trustHome.home,
      offlinePath,
      () => {},
      async ({ screen, write }) => {
        await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
        write('add a total helper');
        await expect.poll(screen).toContain('› add a total helper');
        write(PTY_SUBMIT_INPUT);

        await expect.poll(screen, { timeout: 120_000 }).toContain('Ready to apply');
        await expect.poll(screen, { timeout: 30_000 }).toContain('▌ Apply');
        const sessionId = readActive(target.projectDir);
        if (sessionId === null) throw new Error('no active session');
        writeFileSync(join(target.projectDir, TOTAL_FILE), checkoutSource);
        write('/run accept');
        await expect.poll(screen).toContain('/run accept');
        write('\r');
        await expect
          .poll(screen, { timeout: 30_000 })
          .toContain('Stopped at the review · ⏎ to continue');

        await moveReview({ screen, write }, target, 'none');
        await expect.poll(screen).toContain('Stopped at Apply · ⏎ to continue');
        await expect.poll(screen).toContain('/ for a command…');

        write(draft);
        await expect.poll(screen).toContain(`› ${draft}`);
        write(PTY_SUBMIT_INPUT);
        await expect
          .poll(() => {
            const shown = screen();
            return (
              shown.includes('Cannot send words to Apply. Clear them.') &&
              shown.includes(`› ${draft}`)
            );
          })
          .toBe(true);

        for (let i = 0; i < draft.length; i++) write('\x7f');
        await expect.poll(screen).toContain('/ for a command…');

        writeFileSync(hold, '');
        write('\r');
        await expect.poll(screen, { timeout: 30_000 }).toContain('Checking the merged result');
        await expect.poll(screen).toContain('○ Review → ● Apply');
        writeFileSync(release, '');
        await expect
          .poll(() => readState(target, sessionId).phase, { timeout: 60_000 })
          .toBe('complete');
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
      },
    );
    expect(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'plan',
      `implement ${brief.title}`,
      'final-review',
    ]);
  } finally {
    writeFileSync(release, '');
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

it('e2e: a move from REVIEW None to a seat at rest stops the run at the review, and the seat reads the typed words', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none-move-to-seat');
  const { callsPath, reviewPromptsPath, offlinePath, checkoutSource } = prepareChangedMerge(
    target,
    REVIEW_REPLY,
  );
  writeConfig(target.projectDir, { ...loadConfig(target.projectDir).config, reviewer: 'none' });
  const words = 'also look at negative totals';
  try {
    await inTui(
      target,
      trustHome.home,
      offlinePath,
      () => {},
      async ({ screen, write }) => {
        await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
        write('add a total helper');
        await expect.poll(screen).toContain('› add a total helper');
        write(PTY_SUBMIT_INPUT);

        await expect.poll(screen, { timeout: 120_000 }).toContain(NONE_ROW);
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
        await expect.poll(screen, { timeout: 30_000 }).toContain('▌ Apply');
        const sessionId = readActive(target.projectDir);
        if (sessionId === null) throw new Error('no active session');
        writeFileSync(join(target.projectDir, TOTAL_FILE), checkoutSource);
        write('/run accept');
        await expect.poll(screen).toContain('/run accept');
        write('\r');
        await expect
          .poll(screen, { timeout: 30_000 })
          .toContain('Stopped at Apply · ⏎ to continue');

        await moveReview({ screen, write }, target, 'plan');
        await expect.poll(screen).toContain('Stopped at the review · ⏎ to continue');
        await expect.poll(screen).toContain('Type a correction…');

        write(words);
        await expect.poll(screen).toContain(`› ${words}`);
        write(PTY_SUBMIT_INPUT);
        await expect
          .poll(() => readFileSync(reviewPromptsPath, 'utf8'), { timeout: 60_000 })
          .toContain(words);
        await expect
          .poll(() => readState(target, sessionId).phase, { timeout: 60_000 })
          .toBe('complete');
      },
    );
    expect(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'plan',
      `implement ${brief.title}`,
      'final-review',
    ]);
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

const NO_SEAT_ERROR = 'REVIEW is set to None, so no review seat exists.';
const MESSAGE_REVIEW = 'Message REVIEW';
const DOUBLE_FILE = 'src/double.mjs';
const DOUBLE_TEST_FILE = 'src/double.test.mjs';
const DOUBLE_SOURCE = 'export const double = (a) => a * 2;\n';
const DOUBLE_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { double } from './double.mjs';

test('double twice a number', () => {
  assert.equal(double(2), 4);
});
`;

const secondBrief = makeTaskSpec({
  id: 'T002',
  title: 'Add the double helper',
  intent: 'Return twice a number.',
  criteria: ['C2'],
  suggestedFiles: [DOUBLE_FILE, DOUBLE_TEST_FILE],
  checks: [{ id: 'T002-K1', kind: 'test', value: DOUBLE_TEST_FILE }],
});
const twoBriefPlan = makePlanProposal({
  summary: 'Add a total helper and a double helper.',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] },
    { id: 'C2', text: 'double returns twice a number.', checkIds: ['T002-K1'] },
  ],
  tasks: [brief, secondBrief],
});

/** Every brief's title with the files it writes. */
const BRIEF_FILES = {
  [brief.title]: { [TOTAL_FILE]: TOTAL_SOURCE, [TOTAL_TEST_FILE]: TOTAL_TEST_SOURCE },
  [secondBrief.title]: { [DOUBLE_FILE]: DOUBLE_SOURCE, [DOUBLE_TEST_FILE]: DOUBLE_TEST_SOURCE },
};

/** The planner answers the plan and holds every task review while `hold` exists. */
function heldTaskReviewPlanner(callsPath: string, hold: string, proposal: typeof plan): string {
  return `import { appendFileSync, existsSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const kind = prompt.includes('# Task Implementation Review')
  ? 'task-review'
  : prompt.includes('# Plan the change')
    ? 'plan'
    : 'other';
appendFileSync(${JSON.stringify(callsPath)}, kind + '\\n');
if (kind !== 'plan') {
  const deadline = Date.now() + 120000;
  while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  throw new Error('Unexpected call: ' + kind);
}
process.stdout.write(JSON.stringify(${JSON.stringify({ result: proposal })}));
`;
}

function perBriefImplementer(callsPath: string): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const title = Buffer.concat(chunks).toString('utf8').match(/^## Task: (.+)$/m)?.[1];
appendFileSync(${JSON.stringify(callsPath)}, 'implement ' + title + '\\n');
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(${JSON.stringify(BRIEF_FILES)}[title])) writeFileSync(file, source);
console.log('Implemented ' + title);
`;
}

/** A run under `workflow.review: task` with a seat, whose planner holds the task review. */
function prepareHeldTaskReview(target: StopContinueFixture, proposal: typeof plan) {
  const { callsPath, offlinePath } = prepareRun(target, null);
  const reviewHold = join(target.tmpDir, 'review-hold');
  writeFileSync(
    join(target.tmpDir, 'planner.mjs'),
    heldTaskReviewPlanner(callsPath, reviewHold, proposal),
  );
  writeFileSync(join(target.tmpDir, 'implementer.mjs'), perBriefImplementer(callsPath));
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    workflow: { ...config.workflow, review: 'task' },
  });
  return {
    offlinePath,
    reviewHold,
    calls: () => readFileSync(callsPath, 'utf8').split('\n').filter(Boolean),
  };
}

/** Starts the run, stops it during its first task review, and returns the session. */
async function stopInTaskReview(
  { screen, write }: Tui,
  target: StopContinueFixture,
  run: ReturnType<typeof prepareHeldTaskReview>,
): Promise<string> {
  await expect.poll(screen, { timeout: 60_000 }).toContain('Describe your feature');
  writeFileSync(run.reviewHold, '');
  write('add a total helper');
  await expect.poll(screen).toContain('› add a total helper');
  write(PTY_SUBMIT_INPUT);
  await vi.waitFor(() => expect(run.calls()).toContain('task-review'), { timeout: 120_000 });
  write('\x1b');
  await expect.poll(screen, { timeout: 30_000 }).toContain('Stop now');
  await moveCursorTo(screen, write, '\x1b[B', /▌ Stop now/);
  write('\r');
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) throw new Error('no active session');
  await vi.waitFor(
    () => {
      const state = readState(target, sessionId);
      expect(state.interruptedStep?.cut).toBe('mid-step');
      expect(state.pendingScheduledReview).toEqual({ afterTaskId: brief.id });
    },
    { timeout: 60_000 },
  );
  await expect.poll(screen, { timeout: 30_000 }).toContain('Session options');
  return sessionId;
}

it('e2e: a task review stopped after the last brief ends on a move to REVIEW None, and the run reaches Apply', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none-task-review-last');
  const run = prepareHeldTaskReview(target, plan);
  let noSeatShown = false;
  let moved = false;
  let reviewNamed = false;
  try {
    await inTui(
      target,
      trustHome.home,
      run.offlinePath,
      (shown) => {
        if (shown.includes(NO_SEAT_ERROR)) noSeatShown = true;
        if (moved && shown.includes(MESSAGE_REVIEW)) reviewNamed = true;
      },
      async ({ screen, write }) => {
        const sessionId = await stopInTaskReview({ screen, write }, target, run);
        await expect.poll(screen).toContain('Stopped at the review');

        await moveReview({ screen, write }, target, 'none');
        await expect.poll(screen).toContain('○ Stopped at Apply');
        await expect.poll(screen).toContain('/ for a command…');
        moved = true;

        write('\r');
        await expect
          .poll(
            () => {
              const state = readState(target, sessionId);
              return state.lastFailure?.message ?? state.phase;
            },
            { timeout: 60_000 },
          )
          .toBe('complete');
        await expect.poll(screen, { timeout: 30_000 }).toContain(NONE_ROW);
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
        expect(readState(target, sessionId).pendingScheduledReview).toBeUndefined();
        expect(readState(target, sessionId).reviewStatus).toBe('none');
      },
    );
    expect(run.calls()).toEqual(['plan', `implement ${brief.title}`, 'task-review']);
    expect(noSeatShown).toBe(false);
    expect(reviewNamed).toBe(false);
  } finally {
    rmSync(run.reviewHold, { force: true });
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

it('e2e: a task review stopped before the next brief ends on a move to REVIEW None, and the next brief runs', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  const trustHome = useTrustHome('review-none-task-review-next');
  const run = prepareHeldTaskReview(target, twoBriefPlan);
  let noSeatShown = false;
  let moved = false;
  let reviewNamed = false;
  try {
    await inTui(
      target,
      trustHome.home,
      run.offlinePath,
      (shown) => {
        if (shown.includes(NO_SEAT_ERROR)) noSeatShown = true;
        if (moved && shown.includes(MESSAGE_REVIEW)) reviewNamed = true;
      },
      async ({ screen, write }) => {
        const sessionId = await stopInTaskReview({ screen, write }, target, run);

        await moveReview({ screen, write }, target, 'none');
        await expect.poll(screen).toContain('○ Stopped at T002');
        moved = true;

        write('\r');
        await expect
          .poll(
            () => {
              const state = readState(target, sessionId);
              return state.lastFailure?.message ?? state.phase;
            },
            { timeout: 60_000 },
          )
          .toBe('complete');
        await expect.poll(screen, { timeout: 30_000 }).toContain(NONE_ROW);
        await expect.poll(screen, { timeout: 30_000 }).toContain('Ready to apply');
        expect(readState(target, sessionId).pendingScheduledReview).toBeUndefined();
      },
    );
    expect(run.calls()).toEqual([
      'plan',
      `implement ${brief.title}`,
      'task-review',
      `implement ${secondBrief.title}`,
    ]);
    expect(noSeatShown).toBe(false);
    expect(reviewNamed).toBe(false);
  } finally {
    rmSync(run.reviewHold, { force: true });
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
