import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { waitForStdinRead } from '../helpers/key-log.js';
import { createStopContinueFixture, readState } from '../helpers/stop-continue-fixture.js';
import { forwardTerminalReplies } from '../helpers/terminal-replies.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PATIENCE = { timeout: 60_000 };
const SCENARIO_TIMEOUT = { timeout: 200_000 };
const DRAFT = 'also fix the typo';
const APPROVE_ROW = 'Approve plan and start the build';
const APPROVE_ACTIVE = `▌ ${APPROVE_ROW}`;
const REQUEST_ACTIVE = '▌ Request changes (type what to change)';
const EDIT_ACTIVE = '▌ Edit plan.json';
const DOWN = '\x1b[B';
const CTRL_ENTER = '\x1b[13;5u';
const CTRL_SLASH = '\x1f';
const CTRL_K = '\x0b';
const ESC = '\x1b';

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

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

// The first planner call holds until the test deletes the hold file. Each call saves its prompt
// before it is counted, so a counted call always has its prompt on disk.
function plannerScript(callsPath: string, dir: string, hold: string): string {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  appendFileSync(${JSON.stringify(callsPath)}, 'final-review\\n');
  process.stdout.write(${JSON.stringify(REVIEW_REPLY)});
  process.exit(0);
}
const n = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter((line) => line.startsWith('plan')).length + 1;
writeFileSync(${JSON.stringify(dir)} + '/plan-prompt-' + n + '.txt', prompt);
appendFileSync(${JSON.stringify(callsPath)}, 'plan ' + n + '\\n');
if (n === 1) {
  const deadline = Date.now() + 150000;
  while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

function implementerScript(callsPath: string): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented');
`;
}

function setup() {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const hold = join(target.tmpDir, 'hold');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(hold, '');
  writeFileSync(plannerPath, plannerScript(calls, target.tmpDir, hold));
  writeFileSync(implementerPath, implementerScript(calls));
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('The fixture must declare a shell planner and an agent implementer.');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'plan' },
    validation: { ...config.validation, endChecks: false, testCommand: 'node --test' },
  });
  return { target, hold, offlinePath, calls };
}

type Run = ReturnType<typeof setup>;

const callsMade = (run: Run) => readFileSync(run.calls, 'utf8').split('\n').filter(Boolean);
const planPrompt = (run: Run, n: number) =>
  readFileSync(join(run.target.tmpDir, `plan-prompt-${n}.txt`), 'utf8');

function savedRun(run: Run) {
  const sessionId = readActive(run.target.projectDir);
  if (sessionId === null) throw new Error('The run has no active session.');
  return readState(run.target, sessionId);
}

/** With `pasteWord: false` the terminal gives no word on bracketed paste. */
interface TerminalOptions {
  readonly pasteWord?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

async function inTui(
  run: Run,
  home: string,
  drive: (tui: Tui) => Promise<void>,
  options: TerminalOptions = {},
): Promise<void> {
  const { target, offlinePath } = run;
  const env: Readonly<Record<string, string>> = {
    ...safeChildEnvironment(home),
    XDG_STATE_HOME: target.stateHome,
    ...options.env,
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
      const replyListener = forwardTerminalReplies(terminal, child, options.pasteWord);
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
        replyListener.dispose();
        exitListener.dispose();
        terminal.dispose();
      }
    },
  );
}

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('plan-card-over-draft');
});

afterEach(() => {
  trustHome.restore();
});

// The run starts and the first planner call holds, so the composer is live while the planner runs.
async function scenario(
  drive: (run: Run, tui: Tui) => Promise<void>,
  options: TerminalOptions = {},
) {
  const run = setup();
  try {
    await inTui(
      run,
      trustHome.home,
      async (tui) => {
        await expect.poll(tui.screen, PATIENCE).toContain('Describe your feature');
        tui.write('add a total helper');
        await expect.poll(tui.screen, PATIENCE).toContain('› add a total helper');
        tui.write(PTY_SUBMIT_INPUT);
        await vi.waitFor(() => expect(callsMade(run)).toContain('plan 1'), PATIENCE);
        await drive(run, tui);
      },
      options,
    );
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

async function openCardOverDraft(run: Run, { screen, write }: Tui, draft: string) {
  write(draft);
  await expect.poll(screen, PATIENCE).toContain(`› ${draft}`);
  unlinkSync(run.hold);
  await expect.poll(screen, PATIENCE).toContain(APPROVE_ROW);
}

const replanned = (run: Run) =>
  callsMade(run).some((call) => call === 'plan 2' || call === 'implement');

it(
  'keeps the plan card from approving when ⏎ ends a draft typed while the planner ran',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      await openCardOverDraft(run, tui, DRAFT);

      // The ⏎ that ends the sentence lands the moment the card paints.
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(replanned(run)).toBe(true), PATIENCE);
      expect(callsMade(run)).not.toContain('implement');
      expect(planPrompt(run, 2)).toContain(DRAFT);

      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(savedRun(run).phase).toBe('reviewing-plan');
      expect(callsMade(run)).not.toContain('implement');
    });
  },
);

it(
  'sends the whole sentence to the planner when it ends after the card opened',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      await openCardOverDraft(run, tui, DRAFT);
      expect(screen()).not.toContain(APPROVE_ACTIVE);
      expect(screen()).toContain('tab back to the actions');

      write(' in the second helper');
      await expect.poll(screen, PATIENCE).toContain('in the second helper');
      expect(screen()).toContain(`› ${DRAFT} in the second helper`);
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(replanned(run)).toBe(true), PATIENCE);
      expect(callsMade(run)).not.toContain('implement');
      expect(planPrompt(run, 2)).toContain(`${DRAFT} in the second helper`);
    });
  },
);

it(
  'keeps the run open when the sentence ends in a command word after the card opened',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      const draft = 'I think that is the';
      await openCardOverDraft(run, tui, draft);

      write(' end');
      await expect.poll(screen, PATIENCE).toMatch(/›\s+(I think that is the )?end/);
      expect(screen()).toContain(`› ${draft} end`);
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(
        () => expect(replanned(run) || savedRun(run).closed !== undefined).toBe(true),
        PATIENCE,
      );
      expect(savedRun(run).closed).toBeUndefined();
      expect(screen()).not.toContain('Ended');
      expect(planPrompt(run, 2)).toContain(`${draft} end`);
    });
  },
);

it(
  'gives the plan card the keys when it opens over an empty composer',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, { screen, write }) => {
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(callsMade(run)).toContain('implement'), PATIENCE);
      expect(callsMade(run)).not.toContain('plan 2');
    });
  },
);

// A terminal that gives no word on bracketed paste may send a paste as typed keys, so a pasted
// `ok` and its line break are the same bytes as `ok` and ⏎ of one read there.
it(
  'keeps the plan card waiting on ok and ⏎ of one read on a terminal that gives no word on bracketed paste, and approves on the next ⏎',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(
      async (run, { screen, write }) => {
        unlinkSync(run.hold);
        await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);

        write('ok\r');
        await waitForStdinRead(run.target.projectDir, 'ok\r');
        await vi.waitFor(() => {
          const rows = screen().split('\n');
          const first = rows.findIndex((row) => row.includes('› ok'));
          expect(first, screen()).toBeGreaterThanOrEqual(0);
          expect(rows[first + 1]?.replace(/[│\s]/g, ''), screen()).toBe('');
        }, PATIENCE);
        expect(screen()).toContain(APPROVE_ROW);
        expect(callsMade(run)).toEqual(['plan 1']);

        write('\r');
        await vi.waitFor(() => expect(callsMade(run)).toContain('implement'), PATIENCE);
        expect(callsMade(run)).not.toContain('plan 2');
      },
      { pasteWord: false, env: { SPLITBRIEF_DEBUG_KEYS: '1' } },
    );
  },
);

// The command typed at the focused card is refused and comes back. The card had the keys before
// the line came back, so it keeps them.
it(
  'gives a refused command back at the plan card and leaves the keys on the card',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, { screen, write }) => {
      const command = '/nosuch';
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);

      for (const key of command) write(key);
      await expect.poll(screen, PATIENCE).toContain(`› ${command}`);
      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toContain(`Unknown command: ${command}`);
      await expect.poll(screen, PATIENCE).toContain(`› ${command}`);
      await expect.poll(screen, PATIENCE).toContain(REQUEST_ACTIVE);
      expect(screen()).not.toContain('tab/⏎ back to the actions');

      for (const _ of command) write('\x7f');
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(callsMade(run)).toEqual(['plan 1']);
    });
  },
);

// The card opened over a draft, so the keys stay in the composer through the refused command.
it(
  'approves the plan when ⏎ sends only approve after a refused command over the waiting card',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      const command = '/nosuch';
      await openCardOverDraft(run, tui, command);

      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toContain(`Unknown command: ${command}`);
      await expect.poll(screen, PATIENCE).toContain(`› ${command}`);
      for (const _ of command) write('\x7f');
      await expect.poll(screen, PATIENCE).toContain('tab/⏎ back to the actions');
      write('approve');
      await expect.poll(screen, PATIENCE).toContain('› approve');
      await expect.poll(screen, PATIENCE).toContain('⏎ confirm · tab back to the actions');
      expect(screen()).toContain(APPROVE_ACTIVE);

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(replanned(run)).toBe(true), PATIENCE);
      expect(callsMade(run)).not.toContain('plan 2');
      expect(callsMade(run)).toContain('implement');
    });
  },
);

it(
  'names tab and ⏎ once the draft is deleted, and ⏎ gives the plan card the keys',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      await openCardOverDraft(run, tui, DRAFT);
      await expect.poll(screen, PATIENCE).toContain('tab back to the actions');

      for (const _ of DRAFT) write('\x7f');
      await expect.poll(() => screen().includes(`› ${DRAFT}`), PATIENCE).toBe(false);
      await expect.poll(screen, PATIENCE).toContain('tab/⏎ back to the actions');
      expect(screen()).not.toContain(APPROVE_ACTIVE);

      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(callsMade(run)).not.toContain('plan 2');
      expect(callsMade(run)).not.toContain('implement');
    });
  },
);

it(
  'names tab and ⏎ over a draft of spaces, and ⏎ gives the plan card the keys',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      // The marker makes the typed spaces observable, then the backspace leaves them alone.
      write('   x');
      await expect
        .poll(() => (screen().includes('›    x') ? 'echoed' : screen()), PATIENCE)
        .toBe('echoed');
      write('\x7f');
      await expect.poll(() => screen().includes('›    x'), PATIENCE).toBe(false);

      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ROW);
      await expect.poll(screen, PATIENCE).toContain('tab/⏎ back to the actions');
      expect(screen()).not.toContain(APPROVE_ACTIVE);

      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(callsMade(run)).not.toContain('plan 2');
      expect(callsMade(run)).not.toContain('implement');
    });
  },
);

// An overlay covers the plan card, then closes, and the card is painted again.
async function throughOverlay({ screen, write }: Tui, open: string, close: string) {
  write(open);
  await expect.poll(screen, PATIENCE).not.toContain(APPROVE_ROW);
  write(close);
  await expect.poll(screen, PATIENCE).toContain(APPROVE_ROW);
  await expect.poll(screen, PATIENCE).toContain('Waiting for your answer');
}

it(
  'keeps the plan card on the row it was moved to when help closes over it',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);

      write(DOWN);
      await expect.poll(screen, PATIENCE).toContain(REQUEST_ACTIVE);
      write(DOWN);
      await expect.poll(screen, PATIENCE).toContain(EDIT_ACTIVE);

      await throughOverlay(tui, CTRL_SLASH, ESC);
      expect(screen()).toContain(EDIT_ACTIVE);
      expect(screen()).not.toContain(APPROVE_ACTIVE);
      expect(callsMade(run)).not.toContain('implement');
    });
  },
);

it.each([
  ['help', CTRL_SLASH, ESC],
  ['the stop sheet', ESC, '\t'],
])(
  'sends the draft as a change request when ⏎ follows %s over the waiting plan card',
  SCENARIO_TIMEOUT,
  async (_overlay, open, close) => {
    await scenario(async (run, tui) => {
      await openCardOverDraft(run, tui, DRAFT);
      await expect.poll(tui.screen, PATIENCE).toContain('tab back to the actions');
      await throughOverlay(tui, open, close);

      tui.write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(replanned(run)).toBe(true), PATIENCE);
      expect(callsMade(run)).not.toContain('implement');
      expect(planPrompt(run, 2)).toContain(DRAFT);
    });
  },
);

it(
  'keeps a comment typed in the plan card when the palette closes over it',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      write('rename the helper');
      await expect.poll(screen, PATIENCE).toContain('› rename the helper');
      await throughOverlay(tui, CTRL_K, ESC);

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(replanned(run)).toBe(true), PATIENCE);
      expect(callsMade(run)).not.toContain('implement');
      expect(planPrompt(run, 2)).toContain('rename the helper');
    });
  },
);

it(
  'sends the draft as a change request on ctrl+⏎ over the waiting plan card, and stops nothing',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      await openCardOverDraft(run, tui, DRAFT);
      await expect.poll(screen, PATIENCE).toContain('tab back to the actions');

      write(CTRL_ENTER);
      await vi.waitFor(
        () => expect(replanned(run) || screen().includes('Stopped at the plan')).toBe(true),
        PATIENCE,
      );
      expect(screen()).not.toContain('Stopped at the plan');
      expect(callsMade(run)).not.toContain('implement');
      expect(planPrompt(run, 2)).toContain(DRAFT);

      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(screen()).not.toContain('Stopped at the plan');
    });
  },
);

it(
  'sends the words of /steer as the change request when ⏎ runs it over the waiting plan card',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      const refusal = 'No run to steer in this phase';
      await openCardOverDraft(run, tui, `/steer ${DRAFT}`);

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(
        () => expect(replanned(run) || screen().includes(refusal)).toBe(true),
        PATIENCE,
      );
      expect(screen()).not.toContain(refusal);
      expect(callsMade(run)).toContain('plan 2');
      expect(callsMade(run)).not.toContain('implement');
      expect(planPrompt(run, 2)).toContain(DRAFT);

      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(screen()).not.toContain(refusal);
      expect(screen()).not.toContain('Stopped at the plan');
      expect(callsMade(run)).not.toContain('implement');
    });
  },
);

it('shows a /steer row that is true over the waiting plan card', SCENARIO_TIMEOUT, async () => {
  await scenario(async (run, tui) => {
    const { screen, write } = tui;
    await openCardOverDraft(run, tui, DRAFT);
    for (let i = 0; i < DRAFT.length; i++) write('\x7f');
    await expect.poll(screen, PATIENCE).not.toContain(DRAFT);

    write('/st');
    await expect
      .poll(screen, PATIENCE)
      .toContain('Send a correction now; a running call stops first');
    expect(screen()).toContain('/steer');
    expect(screen()).not.toContain('Stop now and continue');
  });
});
