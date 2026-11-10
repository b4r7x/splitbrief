import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
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
const WORDS = 'also fix the typo';
const CTRL_ENTER = '\x1b[13;5u';

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

function plannerScript(): string {
  return `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

// Each BUILD call saves its prompt before it is counted, so a counted call always has its prompt on disk.
function implementerScript(callsPath: string, dir: string): string {
  return `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const n = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter(Boolean).length + 1;
writeFileSync(${JSON.stringify(dir)} + '/build-prompt-' + n + '.txt', Buffer.concat(chunks).toString('utf8'));
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, 'export const total = (a, b) => a + b;\\n');
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, '// the check command of this run does not read the file\\n');
console.log('Implemented');
`;
}

// The brief check holds until the test writes the release file. While it holds, the run has no model call.
function checkScript(started: string, release: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
writeFileSync(${JSON.stringify(started)}, '');
const deadline = Date.now() + 150_000;
while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await delay(25);
`;
}

function setup() {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const started = join(target.tmpDir, 'check-started');
  const release = join(target.tmpDir, 'check-release');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const checkPath = join(target.tmpDir, 'check.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(plannerPath, plannerScript());
  writeFileSync(implementerPath, implementerScript(calls, target.tmpDir));
  writeFileSync(checkPath, checkScript(started, release));
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('The fixture must declare a shell planner and an agent implementer.');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    validation: { ...config.validation, endChecks: false, testCommand: `node ${checkPath}` },
  });
  return { target, offlinePath, calls, started, release };
}

type Run = ReturnType<typeof setup>;

const buildCalls = (run: Run) => readFileSync(run.calls, 'utf8').split('\n').filter(Boolean).length;
const buildPrompt = (run: Run, n: number) =>
  readFileSync(join(run.target.tmpDir, `build-prompt-${n}.txt`), 'utf8');

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
  trustHome = useTrustHome('send-now-brief-check');
});

afterEach(() => {
  trustHome.restore();
});

// The run reaches the brief check, which holds, so the test types while no model call runs.
async function duringBriefCheck(drive: (run: Run, tui: Tui) => Promise<void>) {
  const run = setup();
  try {
    await inTui(run, trustHome.home, async (tui) => {
      const { screen, write } = tui;
      await expect.poll(screen, PATIENCE).toContain('Describe your feature');
      write('add a total helper');
      await expect.poll(screen, PATIENCE).toContain('› add a total helper');
      write(PTY_SUBMIT_INPUT);
      await expect.poll(() => existsSync(run.started), PATIENCE).toBe(true);
      await expect.poll(screen, PATIENCE).toContain('Check T001-K1');
      await drive(run, tui);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

it('continues the run with the words when ctrl+⏎ sends them while a brief check runs', {
  timeout: 200_000,
}, async () => {
  await duringBriefCheck(async (run, { screen, write }) => {
    write(WORDS);
    await expect.poll(screen, PATIENCE).toContain(`› ${WORDS}`);

    write(CTRL_ENTER);
    await vi.waitFor(
      () => expect(buildCalls(run) > 1 || screen().includes('Session options')).toBe(true),
      PATIENCE,
    );
    expect(screen()).not.toContain('Session options');
    expect(buildPrompt(run, 2)).toContain(WORDS);
  });
});

it('continues the run with the words when /steer sends them while a brief check runs', {
  timeout: 200_000,
}, async () => {
  await duringBriefCheck(async (run, { screen, write }) => {
    const refusal = 'No run to steer in this phase';
    write(`/steer ${WORDS}`);
    await expect.poll(screen, PATIENCE).toContain(`› /steer ${WORDS}`);

    write(PTY_SUBMIT_INPUT);
    await vi.waitFor(
      () =>
        expect(
          buildCalls(run) > 1 || screen().includes(refusal) || screen().includes('Session options'),
        ).toBe(true),
      PATIENCE,
    );
    expect(screen()).not.toContain(refusal);
    expect(screen()).not.toContain('Session options');
    expect(buildPrompt(run, 2)).toContain(WORDS);
  });
});
