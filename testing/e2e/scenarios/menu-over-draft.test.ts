import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { UNREAD_WORDS_MESSAGE } from '../../../src/features/workflow/inline-menu/use-keys.js';
import { waitForStdinRead } from '../helpers/key-log.js';
import { createStopContinueFixture, readState } from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PATIENCE = { timeout: 60_000 };
const SCENARIO_TIMEOUT = { timeout: 200_000 };
const DRAFT = 'also fix the typo';

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_TEST_SOURCE =
  "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { total } from './total.mjs';\ntest('t', () => assert.equal(total(1, 2), 3));\n";
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

type HoldAt = 'final-review' | 'seat-down';
type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

const holdLoop = (hold: string) =>
  `{ const deadline = Date.now() + 150000; while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25)); }`;

function plannerScript(holdAt: HoldAt, callsPath: string, hold: string): string {
  return `import { appendFileSync, existsSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  appendFileSync(${JSON.stringify(callsPath)}, 'final-review\\n');
  if (${JSON.stringify(holdAt)} === 'final-review') ${holdLoop(hold)}
  process.stdout.write(${JSON.stringify(REVIEW_REPLY)});
  process.exit(0);
}
if (!prompt.includes('# Plan the change')) throw new Error('Unexpected prompt: ' + prompt);
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

function implementerScript(holdAt: HoldAt, callsPath: string, dir: string, hold: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const n = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter((line) => line === 'implement').length + 1;
writeFileSync(${JSON.stringify(dir)} + '/prompt-' + n + '.txt', prompt);
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
if (${JSON.stringify(holdAt)} === 'seat-down') {
  ${holdLoop(hold)}
  console.error("You've hit your usage limit");
  process.exit(1);
}
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented');
`;
}

function setup(holdAt: HoldAt) {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const hold = join(target.tmpDir, 'hold');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(hold, '');
  writeFileSync(plannerPath, plannerScript(holdAt, calls, hold));
  writeFileSync(implementerPath, implementerScript(holdAt, calls, target.tmpDir, hold));
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('The fixture must declare a shell planner and an agent implementer.');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, endChecks: false, testCommand: 'node --test' },
  });
  return { target, hold, offlinePath, calls };
}

type Run = ReturnType<typeof setup>;

const callsMade = (run: Run) => readFileSync(run.calls, 'utf8').split('\n').filter(Boolean);
const implementerCalls = (run: Run) => callsMade(run).filter((call) => call === 'implement').length;
const checkoutHasTotal = (run: Run) => existsSync(join(run.target.projectDir, TOTAL_FILE));

function savedRun(run: Run) {
  const sessionId = readActive(run.target.projectDir);
  if (sessionId === null) throw new Error('The run has no active session.');
  return readState(run.target, sessionId);
}

async function inTui(
  run: Run,
  home: string,
  drive: (tui: Tui) => Promise<void>,
  extraEnv: Readonly<Record<string, string>>,
): Promise<void> {
  const { target, offlinePath } = run;
  const env: Readonly<Record<string, string>> = {
    ...safeChildEnvironment(home),
    XDG_STATE_HOME: target.stateHome,
    ...extraEnv,
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
      const dataListener = child.onData((data) => terminal.write(data));
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

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('menu-over-draft');
});

afterEach(() => {
  trustHome.restore();
});

async function scenario(
  holdAt: HoldAt,
  drive: (run: Run, tui: Tui) => Promise<void>,
  extraEnv: Readonly<Record<string, string>> = {},
) {
  const run = setup(holdAt);
  try {
    await inTui(
      run,
      trustHome.home,
      async (tui) => {
        await expect.poll(tui.screen, PATIENCE).toContain('Describe your feature');
        tui.write('add a total helper');
        await expect.poll(tui.screen, PATIENCE).toContain('› add a total helper');
        tui.write(PTY_SUBMIT_INPUT);
        await drive(run, tui);
      },
      extraEnv,
    );
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

async function typeDraftWhileHeld({ screen, write }: Tui) {
  write(DRAFT);
  await expect.poll(screen, PATIENCE).toContain(`› ${DRAFT}`);
}

it(
  'leaves the keys in the composer when the result menu opens over a draft',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario('final-review', async (run, tui) => {
      const { screen, write } = tui;
      await vi.waitFor(() => expect(callsMade(run)).toContain('final-review'), PATIENCE);
      await typeDraftWhileHeld(tui);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain('Ready to apply');

      // The ⏎ that ends the sentence lands the moment the menu paints.
      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toMatch(/Only \/commands here|Applied/);
      expect(screen()).not.toContain('Applied');
      expect(checkoutHasTotal(run)).toBe(false);
      expect(screen()).not.toContain('goes home');
      expect(screen()).toContain('tab back to the actions');

      write(' in the second helper');
      await expect.poll(screen, PATIENCE).toContain(`› ${DRAFT} in the second helper`);
      write(PTY_SUBMIT_INPUT);
      write('\t');
      await expect.poll(screen, PATIENCE).toContain('▌ Apply');
      expect(screen()).not.toContain('Applied');
      expect(checkoutHasTotal(run)).toBe(false);
    });
  },
);

it(
  'leaves the keys in the composer when Seat down opens over a draft',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario('seat-down', async (run, tui) => {
      const { screen, write } = tui;
      await vi.waitFor(() => expect(implementerCalls(run)).toBe(1), PATIENCE);
      await typeDraftWhileHeld(tui);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain('Try again');
      writeFileSync(run.hold, '');

      let typed = DRAFT;
      for (const letter of ' second and more') {
        typed += letter;
        write(letter);
        const echo = `› ${typed.trimEnd()}`;
        await expect
          .poll(() => (screen().includes(echo) ? 'echoed' : screen()), PATIENCE)
          .toMatch(/^echoed$|skipped|Ended/);
        const saved = savedRun(run);
        expect(saved.tasks.map((task) => `${task.id}:${task.status}`)).not.toContain(
          'T001:skipped',
        );
        expect(saved.pendingRecovery?.reason).toBe('runner-usage-limit');
      }
      expect(implementerCalls(run)).toBe(1);
      expect(screen()).toContain('tab back to the actions');

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(implementerCalls(run)).toBe(2), PATIENCE);
      expect(readFileSync(join(run.target.tmpDir, 'prompt-2.txt'), 'utf8')).toContain(
        `The user says: ${DRAFT} second and more`,
      );
    });
  },
);

it(
  'sends the words of /steer to the retry when ⏎ runs it over Seat down, and stops nothing',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario('seat-down', async (run, { screen, write }) => {
      await vi.waitFor(() => expect(implementerCalls(run)).toBe(1), PATIENCE);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain('Try again');
      await expect.poll(screen, PATIENCE).toContain('⏎ confirm');
      writeFileSync(run.hold, '');

      write(`/steer ${DRAFT}`);
      await expect.poll(screen, PATIENCE).toContain(`› /steer ${DRAFT}`);
      write(PTY_SUBMIT_INPUT);

      await vi.waitFor(() => expect(implementerCalls(run)).toBe(2), PATIENCE);
      expect(readFileSync(join(run.target.tmpDir, 'prompt-2.txt'), 'utf8')).toContain(
        `The user says: ${DRAFT}`,
      );
      expect(savedRun(run).pendingRecovery).toBeUndefined();
      await expect.poll(screen, PATIENCE).not.toContain('tab back to the actions');
      expect(screen()).not.toContain('⏎ confirm');
      expect(screen()).not.toContain('Choose an action above');
    });
  },
);

it(
  'gives the result menu the keys when it opens over an empty composer',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario('final-review', async (run, { screen, write }) => {
      await vi.waitFor(() => expect(callsMade(run)).toContain('final-review'), PATIENCE);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain('Ready to apply');
      await expect.poll(screen, PATIENCE).toContain('▌ Apply');

      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toContain('Applied');
      expect(checkoutHasTotal(run)).toBe(true);
    });
  },
);

it(
  'gives the recovery menu the keys when it opens over an empty composer',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario('seat-down', async (run, { screen, write }) => {
      await vi.waitFor(() => expect(implementerCalls(run)).toBe(1), PATIENCE);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain('Try again');
      await expect.poll(screen, PATIENCE).toContain('⏎ confirm');
      writeFileSync(run.hold, '');

      write('r');
      await vi.waitFor(() => expect(implementerCalls(run)).toBe(2), PATIENCE);
    });
  },
);

// A word names no action: the ⏎ of the same read takes no row and says how to choose one.
it(
  'keeps the Seat down halt open on skip and ⏎ of one read and says how to choose',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(
      'seat-down',
      async (run, { screen, write }) => {
        await vi.waitFor(() => expect(implementerCalls(run)).toBe(1), PATIENCE);
        unlinkSync(run.hold);
        await expect.poll(screen, PATIENCE).toContain('Try again');
        await expect.poll(screen, PATIENCE).toContain('⏎ confirm');
        writeFileSync(run.hold, '');

        write('skip\r');
        const outcome = () => {
          if (screen().includes(UNREAD_WORDS_MESSAGE)) return 'refused';
          const acted = implementerCalls(run) > 1 || savedRun(run).pendingRecovery === undefined;
          return acted ? 'acted' : 'open';
        };
        await expect.poll(outcome, PATIENCE).not.toBe('open');
        const seen = outcome();
        await waitForStdinRead(run.target.projectDir, 'skip\r');
        expect(seen).toBe('refused');
        const saved = savedRun(run);
        expect(saved.pendingRecovery?.reason).toBe('runner-usage-limit');
        expect(saved.tasks.map((task) => `${task.id}:${task.status}`)).not.toContain(
          'T001:skipped',
        );
        expect(implementerCalls(run)).toBe(1);
      },
      { SPLITBRIEF_DEBUG_KEYS: '1' },
    );
  },
);

it(
  'keeps a ready run out of the checkout on discard and ⏎ of one read and says how to choose',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(
      'final-review',
      async (run, { screen, write }) => {
        await vi.waitFor(() => expect(callsMade(run)).toContain('final-review'), PATIENCE);
        unlinkSync(run.hold);
        await expect.poll(screen, PATIENCE).toContain('Ready to apply');
        await expect.poll(screen, PATIENCE).toContain('▌ Apply');

        write('discard\r');
        const outcome = () => {
          if (screen().includes(UNREAD_WORDS_MESSAGE)) return 'refused';
          return screen().includes('Applied') || checkoutHasTotal(run) ? 'applied' : 'open';
        };
        await expect.poll(outcome, PATIENCE).not.toBe('open');
        const seen = outcome();
        await waitForStdinRead(run.target.projectDir, 'discard\r');
        expect(seen).toBe('refused');
        expect(screen()).toContain('Ready to apply');
        expect(checkoutHasTotal(run)).toBe(false);
      },
      { SPLITBRIEF_DEBUG_KEYS: '1' },
    );
  },
);

// Two Tab keys of one read hold no typed words, so the ⏎ after them takes the highlighted row.
it(
  'applies a ready run on ⏎ after two Tab keys of one read, with no line about typed words',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(
      'final-review',
      async (run, { screen, write }) => {
        await vi.waitFor(() => expect(callsMade(run)).toContain('final-review'), PATIENCE);
        unlinkSync(run.hold);
        await expect.poll(screen, PATIENCE).toContain('Ready to apply');
        await expect.poll(screen, PATIENCE).toContain('▌ Apply');

        write('\t\t');
        await waitForStdinRead(run.target.projectDir, '\t\t');
        write(PTY_SUBMIT_INPUT);
        const outcome = () => {
          if (screen().includes(UNREAD_WORDS_MESSAGE)) return 'refused';
          return screen().includes('Applied') || checkoutHasTotal(run) ? 'applied' : 'open';
        };
        await expect.poll(outcome, PATIENCE).not.toBe('open');
        expect(outcome()).toBe('applied');
        await expect.poll(screen, PATIENCE).toContain('Applied');
        expect(checkoutHasTotal(run)).toBe(true);
      },
      { SPLITBRIEF_DEBUG_KEYS: '1' },
    );
  },
);
