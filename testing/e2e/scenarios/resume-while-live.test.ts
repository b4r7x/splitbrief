import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
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
import { createStopContinueFixture } from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PAINT = { timeout: 15_000 };
const RUN = { timeout: 120_000 };
const REFUSAL = 'Nothing to resume: the run has not stopped.';

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

type HeldCall = 'plan' | 'build';
type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

// The held call waits while the hold file exists, so the test decides when it ends on its own.
// A call that gets SIGTERM records it in calls.txt.
const holdLoop = (hold: string) =>
  `{ const deadline = Date.now() + 150000; while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25)); }`;

function plannerScript(held: HeldCall, callsPath: string, hold: string): string {
  return `import { appendFileSync, existsSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  appendFileSync(${JSON.stringify(callsPath)}, 'final-review\\n');
  process.stdout.write(${JSON.stringify(REVIEW_REPLY)});
  process.exit(0);
}
process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(callsPath)}, 'plan-sigterm\\n'); process.exit(143); });
appendFileSync(${JSON.stringify(callsPath)}, 'plan\\n');
if (${JSON.stringify(held)} === 'plan') ${holdLoop(hold)}
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

function implementerScript(held: HeldCall, callsPath: string, hold: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(callsPath)}, 'implement-sigterm\\n'); process.exit(143); });
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
if (${JSON.stringify(held)} === 'build') ${holdLoop(hold)}
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented');
`;
}

function setup(held: HeldCall) {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const hold = join(target.tmpDir, 'hold');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(hold, '');
  writeFileSync(plannerPath, plannerScript(held, calls, hold));
  writeFileSync(implementerPath, implementerScript(held, calls, hold));
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
  return { target, offlinePath, calls, hold };
}

type Run = ReturnType<typeof setup>;

const callsMade = (run: Run) => readFileSync(run.calls, 'utf8').split('\n').filter(Boolean);

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
  trustHome = useTrustHome('resume-while-live');
});

afterEach(() => {
  trustHome.restore();
});

it.each<[string, HeldCall]>([
  ['the build call', 'build'],
  ['the planner call', 'plan'],
])(
  'refuses /resume while %s runs, stops nothing, and the run goes on',
  {
    timeout: 200_000,
  },
  async (_, held) => {
    const run = setup(held);
    const heldCall = held === 'build' ? 'implement' : 'plan';
    try {
      await inTui(run, trustHome.home, async ({ screen, write }) => {
        await expect.poll(screen, RUN).toContain('Describe your feature');
        write('add a total helper');
        await expect.poll(screen, PAINT).toContain('› add a total helper');
        write(PTY_SUBMIT_INPUT);
        await vi.waitFor(() => expect(callsMade(run)).toContain(heldCall), RUN);

        write('/resume');
        await expect.poll(screen, PAINT).toContain('› /resume');
        write(PTY_SUBMIT_INPUT);
        await expect.poll(screen, PAINT).toContain(REFUSAL);
        await expect.poll(screen, PAINT).toContain('› /resume');
        expect(callsMade(run)).not.toContain(`${heldCall}-sigterm`);

        unlinkSync(run.hold);
        await vi.waitFor(() => expect(callsMade(run)).toContain('final-review'), RUN);
        expect(callsMade(run)).toEqual(['plan', 'implement', 'final-review']);
      });
    } finally {
      if (existsSync(run.hold)) unlinkSync(run.hold);
      cleanupTempDir(run.target.tmpDir);
    }
  },
);
