import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import type { PlanProposal } from '../../../src/core/schemas/plan.js';
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
const DOWN = '\x1b[B';
const APPROVE_ACTIVE = '▌ Approve plan and start the build';
const REQUEST_ACTIVE = '▌ Request changes (type what to change)';
const CORRECTION_GOES_AGAIN = 'Your plan correction goes again with this step.';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: ['src/total.mjs', 'src/total.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/total.test.mjs' }],
});
const firstPlan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  gate: ['npm test'],
  tasks: [brief],
});

const SEVEN_GATE_COMMANDS = [
  'npm run format:check',
  'npm run typecheck',
  'npm run lint',
  'npm test',
  'npm run test:integration',
  'npm run build',
  'npm run test:e2e',
];
const SEVEN_GATE_CORRECTION =
  'Run 7 gate commands: format:check, typecheck, lint, test, test:integration, build, test:e2e';
const sevenGatePlan: PlanProposal = {
  ...firstPlan,
  summary: 'Add a total helper with its test and a project gate of 7 commands.',
  gate: SEVEN_GATE_COMMANDS,
};

const RENAME_CORRECTION = 'Name the helper sum, not total';
const renamedPlan: PlanProposal = {
  ...firstPlan,
  summary: 'Add a sum helper with its test.',
};

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

// The first plan call answers with the first plan. A later plan call fails while the fail file
// exists, and answers with the revised plan when it does not. Each call saves its prompt before it
// is counted, so a counted call always has its prompt on disk.
function plannerScript(calls: string, dir: string, fail: string, revised: PlanProposal): string {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const n = readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter(Boolean).length + 1;
writeFileSync(${JSON.stringify(dir)} + '/plan-prompt-' + n + '.txt', prompt);
appendFileSync(${JSON.stringify(calls)}, 'plan ' + n + '\\n');
if (n > 1 && existsSync(${JSON.stringify(fail)})) {
  process.stderr.write('The planner process crashed.\\n');
  process.exit(1);
}
process.stdout.write(n === 1 ? ${JSON.stringify(JSON.stringify({ result: firstPlan }))} : ${JSON.stringify(JSON.stringify({ result: revised }))});
`;
}

function setup(revised: PlanProposal) {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const fail = join(target.tmpDir, 'fail');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(plannerPath, plannerScript(calls, target.tmpDir, fail, revised));
  // No plan is approved here, so the build tool never runs.
  writeFileSync(implementerPath, 'for await (const chunk of process.stdin) void chunk;\n');
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
  });
  return { target, fail, offlinePath, calls };
}

type Run = ReturnType<typeof setup>;

const plannerCalls = (run: Run) =>
  readFileSync(run.calls, 'utf8').split('\n').filter(Boolean).length;
const planPrompt = (run: Run, n: number) =>
  readFileSync(join(run.target.tmpDir, `plan-prompt-${n}.txt`), 'utf8');

function savedRun(run: Run) {
  const sessionId = readActive(run.target.projectDir);
  if (sessionId === null) throw new Error('The run has no active session.');
  return readState(run.target, sessionId);
}

// The screen as one line of words: no frame, and a wrapped sentence reads whole.
const words = (screen: string) => screen.replace(/[─-╿]/g, ' ').replace(/\s+/g, ' ');

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
  trustHome = useTrustHome('plan-correction');
});

afterEach(() => {
  trustHome.restore();
});

// The run starts and shows the plan card of the first plan, with the keys on its rows.
async function scenario(revised: PlanProposal, drive: (run: Run, tui: Tui) => Promise<void>) {
  const run = setup(revised);
  try {
    await inTui(run, trustHome.home, async (tui) => {
      await expect.poll(tui.screen, PATIENCE).toContain('Describe your feature');
      tui.write('add a total helper');
      await expect.poll(tui.screen, PATIENCE).toContain('› add a total helper');
      tui.write(PTY_SUBMIT_INPUT);
      await expect.poll(tui.screen, PATIENCE).toContain(APPROVE_ACTIVE);
      await drive(run, tui);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

// The user picks Request changes on the plan card, types the correction and sends it.
async function requestChanges({ screen, write }: Tui, correction: string) {
  write(DOWN);
  await expect.poll(screen, PATIENCE).toContain(REQUEST_ACTIVE);
  write(PTY_SUBMIT_INPUT);
  await expect.poll(screen, PATIENCE).toContain('⏎ send');
  write(correction);
  await expect.poll(screen, PATIENCE).toContain(`› ${correction}`);
  write(PTY_SUBMIT_INPUT);
}

it(
  'shows the plan card again with all 7 gate commands when a correction asks for 7',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(sevenGatePlan, async (run, tui) => {
      const { screen } = tui;
      await requestChanges(tui, SEVEN_GATE_CORRECTION);

      await expect
        .poll(() => /Seat down|a project gate of 7 commands/.test(screen()), PATIENCE)
        .toBe(true);
      expect(screen()).not.toContain('Seat down');
      expect(words(screen())).not.toContain('did not match its contract');
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);

      expect(words(screen())).toContain(
        SEVEN_GATE_COMMANDS.map((command, index) => `V${index + 1}: ${command}`).join(' • '),
      );
      expect(savedRun(run).plan?.gate).toEqual(SEVEN_GATE_COMMANDS);
      expect(savedRun(run).phase).toBe('reviewing-plan');
    });
  },
);

it(
  'says on the Seat down panel that the plan correction goes again, and Try again sends it again',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(renamedPlan, async (run, tui) => {
      const { screen, write } = tui;
      writeFileSync(run.fail, '');
      await requestChanges(tui, RENAME_CORRECTION);

      await expect.poll(screen, PATIENCE).toContain('Seat down');
      await expect.poll(screen, PATIENCE).toContain('Try again');
      await expect.poll(screen, PATIENCE).toContain('⏎ confirm');
      expect.soft(words(screen())).toContain(CORRECTION_GOES_AGAIN);
      expect.soft(words(screen())).not.toContain('Words that you type here');
      expect(savedRun(run).rewindPending?.comment).toBe(RENAME_CORRECTION);

      const failed = plannerCalls(run);
      unlinkSync(run.fail);
      write('r');
      await vi.waitFor(() => expect(plannerCalls(run)).toBe(failed + 1), PATIENCE);
      expect(planPrompt(run, failed + 1)).toContain(
        `The user asked for changes to the plan:\n\n${RENAME_CORRECTION}`,
      );

      await expect.poll(screen, PATIENCE).toContain('Add a sum helper with its test.');
      await expect.poll(screen, PATIENCE).toContain(APPROVE_ACTIVE);
      expect(screen()).not.toContain('Seat down');
      expect(savedRun(run).rewindPending).toBeUndefined();
      expect(savedRun(run).phase).toBe('reviewing-plan');
    });
  },
);
