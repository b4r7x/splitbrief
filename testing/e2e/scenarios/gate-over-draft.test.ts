import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import { SessionLogEntrySchema } from '../../../src/core/schemas/session-log.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { CONFIRM_QUESTION } from '../../../src/features/workflow/prompt-rows/approval.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { createStopContinueFixture } from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PATIENCE = { timeout: 60_000 };
const SCENARIO_TIMEOUT = { timeout: 200_000 };
const DRAFT = 'also fix the typo';
const GATE_TITLE = 'Change a package manifest:';

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_TEST_SOURCE =
  "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { total } from './total.mjs';\ntest('t', () => assert.equal(total(1, 2), 3));\n";
// The plan lists only the two total files, so this write is one the gate asks about.
const MANIFEST = '{ "name": "total", "dependencies": { "left-pad": "1.3.0" } }\n';
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

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

function plannerScript(): string {
  return `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (!prompt.includes('# Plan the change')) throw new Error('Unexpected prompt: ' + prompt);
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

// The call writes its files, names the folder it ran in, and holds until the test ends the hold:
// the gate opens when the call ends.
function implementerScript(callsPath: string, workspacePath: string, hold: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
writeFileSync('package.json', ${JSON.stringify(MANIFEST)});
writeFileSync(${JSON.stringify(workspacePath)}, process.cwd());
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
{ const deadline = Date.now() + 150000; while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25)); }
console.log('Implemented');
`;
}

function setup() {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const workspace = join(target.tmpDir, 'workspace.txt');
  const hold = join(target.tmpDir, 'hold');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(hold, '');
  writeFileSync(plannerPath, plannerScript());
  writeFileSync(implementerPath, implementerScript(calls, workspace, hold));
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
  return { target, hold, offlinePath, calls, workspace };
}

type Run = ReturnType<typeof setup>;

const implementerCalls = (run: Run) =>
  readFileSync(run.calls, 'utf8')
    .split('\n')
    .filter((call) => call === 'implement').length;

function sessionRef(run: Run) {
  const sessionId = readActive(run.target.projectDir);
  if (sessionId === null) throw new Error('The run has no active session.');
  return { projectDir: run.target.projectDir, sessionId };
}

function readLog(run: Run) {
  const ref = sessionRef(run);
  const file = join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => SessionLogEntrySchema.parse(JSON.parse(line)));
}

const approvalEvents = (run: Run) =>
  readLog(run).flatMap((entry) =>
    entry.kind === 'event' && entry.type.startsWith('approval_') ? [entry.type] : [],
  );

const queuedTexts = (run: Run) =>
  readLog(run).flatMap((entry) =>
    entry.kind === 'message' && entry.role === 'user' && entry.queueMessageId !== undefined
      ? [entry.text]
      : [],
  );

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
  trustHome = useTrustHome('gate-over-draft');
});

afterEach(() => {
  trustHome.restore();
});

// BUILD holds while the user types a correction; the gate opens over it when the call ends.
async function gateOverDraft(drive: (run: Run, tui: Tui) => Promise<void>) {
  const run = setup();
  try {
    await inTui(run, trustHome.home, async (tui) => {
      const { screen, write } = tui;
      await expect.poll(screen, PATIENCE).toContain('Describe your feature');
      write('add a total helper');
      await expect.poll(screen, PATIENCE).toContain('› add a total helper');
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(implementerCalls(run)).toBe(1), PATIENCE);
      write(DRAFT);
      await expect.poll(screen, PATIENCE).toContain(`› ${DRAFT}`);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(GATE_TITLE);
      await drive(run, tui);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

async function typeLetters({ screen, write }: Tui, typed: string, letters: string) {
  let shown = typed;
  for (const letter of letters) {
    shown += letter;
    write(letter);
    const echo = `› ${shown.trimEnd()}`;
    await expect
      .poll(() => (screen().includes(echo) ? 'echoed' : screen()), PATIENCE)
      .toBe('echoed');
  }
}

it('queues the draft for BUILD on ⏎ and the gate keeps waiting', SCENARIO_TIMEOUT, async () => {
  await gateOverDraft(async (run, { screen, write }) => {
    write(PTY_SUBMIT_INPUT);
    await expect.poll(screen, PATIENCE).toContain('Queued for BUILD');
    expect(screen()).toContain(GATE_TITLE);
    expect(readEvidenceLedger(sessionRef(run))?.approvals ?? []).toEqual([]);
  });
});

it(
  'keeps every late letter in the draft and queues the whole sentence',
  SCENARIO_TIMEOUT,
  async () => {
    await gateOverDraft(async (run, tui) => {
      await typeLetters(tui, DRAFT, ' in the second helper');
      tui.write(PTY_SUBMIT_INPUT);
      await vi.waitFor(
        () => expect(queuedTexts(run)).toEqual([`${DRAFT} in the second helper`]),
        PATIENCE,
      );
      expect(approvalEvents(run)).not.toContain('approval_rejected');
      expect(existsSync(join(readFileSync(run.workspace, 'utf8'), 'package.json'))).toBe(true);
    });
  },
);

it('opens no reason field for an r in the draft', SCENARIO_TIMEOUT, async () => {
  await gateOverDraft(async (_run, tui) => {
    await typeLetters(tui, DRAFT, ' or drop it');
    expect(tui.screen()).not.toContain(CONFIRM_QUESTION);
  });
});

it('gives the gate the keys on Tab, and y confirms', SCENARIO_TIMEOUT, async () => {
  await gateOverDraft(async (run, { screen, write }) => {
    await expect.poll(screen, PATIENCE).toContain('tab back to the actions');
    write('\t');
    await expect.poll(screen, PATIENCE).toContain('▌ y   Confirm');
    write('y');
    await vi.waitFor(() => expect(approvalEvents(run)).toContain('approval_granted'), PATIENCE);
  });
});
