import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { createStopContinueFixture, readState } from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PATIENCE = { timeout: 60_000 };
const SCENARIO_TIMEOUT = { timeout: 200_000 };
const END = '/end';
const REFUSAL = 'No run to end in this phase';
const PLAN_CARD = 'Approve plan and start the build';
// The closed screen of each place is the one that its End run row gives.
const ENDED_AT_CARD = ['× Ended  Plan 0/1 · nothing built', 'Run closed · '];
const ENDED_IN_CHECK = [
  '× Ended  Build 0/1 · stopped at T001 · changes saved in run.patch',
  'Ended · bring the changes back with git apply on the Patch file',
];

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

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;
type Wait = 'plan-card' | 'brief-check';

// The planner call holds while the hold file exists, so the composer is live while the planner runs.
function plannerScript(planning: string, hold: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
writeFileSync(${JSON.stringify(planning)}, '');
const deadline = Date.now() + 150000;
while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

function implementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, 'export const total = (a, b) => a + b;\\n');
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, '// the check command of this run does not read the file\\n');
console.log('Implemented');
`;
}

// The brief check holds until the run stops it. While it holds, the run has no model call.
function checkScript(checking: string): string {
  return `import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
writeFileSync(${JSON.stringify(checking)}, '');
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) await delay(25);
`;
}

function setup(at: Wait) {
  const target = createStopContinueFixture(() => '');
  const planning = join(target.tmpDir, 'planning');
  const hold = join(target.tmpDir, 'hold');
  const checking = join(target.tmpDir, 'checking');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const checkPath = join(target.tmpDir, 'check.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  if (at === 'plan-card') writeFileSync(hold, '');
  writeFileSync(plannerPath, plannerScript(planning, hold));
  writeFileSync(implementerPath, implementerScript());
  writeFileSync(checkPath, checkScript(checking));
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('The fixture must declare a shell planner and an agent implementer.');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: at === 'plan-card' ? 'plan' : 'none' },
    validation: { ...config.validation, endChecks: false, testCommand: `node ${checkPath}` },
  });
  return { target, offlinePath, planning, hold, checking };
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
  trustHome = useTrustHome('end-command-live');
});

afterEach(() => {
  trustHome.restore();
});

// `reach` brings the run to the place where it waits, with /end typed in the composer. ⏎ then runs it.
async function endsTheRun(
  at: Wait,
  closedScreen: readonly string[],
  reach: (run: Run, tui: Tui) => Promise<void>,
) {
  const run = setup(at);
  try {
    await inTui(run, trustHome.home, async (tui) => {
      const { screen, write } = tui;
      await expect.poll(screen, PATIENCE).toContain('Describe your feature');
      write('add a total helper');
      await expect.poll(screen, PATIENCE).toContain('› add a total helper');
      write(PTY_SUBMIT_INPUT);
      await reach(run, tui);
      const sessionId = readActive(run.target.projectDir);
      if (sessionId === null) throw new Error('The run has no active session.');

      write(PTY_SUBMIT_INPUT);
      await expect.poll(() => readState(run.target, sessionId).closed?.as, PATIENCE).toBe('ended');
      for (const text of closedScreen) await expect.poll(screen, PATIENCE).toContain(text);
      expect(screen()).not.toContain(REFUSAL);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

it('ends the run when /end runs over the plan card', SCENARIO_TIMEOUT, async () => {
  await endsTheRun('plan-card', ENDED_AT_CARD, async (run, { screen, write }) => {
    await expect.poll(() => existsSync(run.planning), PATIENCE).toBe(true);
    write(END);
    await expect.poll(screen, PATIENCE).toContain(`› ${END}`);
    unlinkSync(run.hold);
    await expect.poll(screen, PATIENCE).toContain(PLAN_CARD);
  });
});

it('ends the run when /end runs while a brief check runs', SCENARIO_TIMEOUT, async () => {
  await endsTheRun('brief-check', ENDED_IN_CHECK, async (run, { screen, write }) => {
    await expect.poll(() => existsSync(run.checking), PATIENCE).toBe(true);
    await expect.poll(screen, PATIENCE).toContain('Check T001-K1');
    write(END);
    await expect.poll(screen, PATIENCE).toContain(`› ${END}`);
  });
});
