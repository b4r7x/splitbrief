import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
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
const QUESTION_PANEL = 'Question 1 of 1';
const DEFAULT_ANSWER = 'Integers only';
const PLAN_CARD = 'Approve plan and start the build';
const STOPPED = 'Stopped at the plan';
const MISTYPED = '/ster reword it';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: ['src/total.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/total.test.mjs' }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const QUESTIONS = {
  kind: 'questions',
  questions: [
    {
      id: 'q1',
      text: 'Which numbers must total accept?',
      choices: [DEFAULT_ANSWER, 'Any finite number'],
      default: DEFAULT_ANSWER,
    },
  ],
};

type Tui = Readonly<{ screen: () => string; write: (keys: string) => void }>;

// Each call saves its prompt before it is counted, then waits for its hold file to be removed if present.
function plannerScript(callsPath: string, dir: string, holdPaths: readonly string[]): string {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const n = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter((line) => line.startsWith('plan')).length + 1;
writeFileSync(${JSON.stringify(dir)} + '/plan-prompt-' + n + '.txt', prompt);
appendFileSync(${JSON.stringify(callsPath)}, 'plan ' + n + '\\n');
const hold = ${JSON.stringify(holdPaths)}[n - 1];
if (hold !== undefined) {
  const deadline = Date.now() + 150000;
  while (existsSync(hold) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}
process.stdout.write(JSON.stringify({ result: n === 1 ? ${JSON.stringify(QUESTIONS)} : ${JSON.stringify(plan)} }));
`;
}

function implementerScript(callsPath: string): string {
  return `import { appendFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
console.log('Implemented');
`;
}

function setup() {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const hold = join(target.tmpDir, 'hold');
  const planHold = join(target.tmpDir, 'hold-plan');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(hold, '');
  writeFileSync(plannerPath, plannerScript(calls, target.tmpDir, [hold, planHold]));
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
  });
  return { target, hold, planHold, offlinePath, calls };
}

type Run = ReturnType<typeof setup>;

const planCalls = (run: Run) =>
  readFileSync(run.calls, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('plan')).length;
const planPrompt = (run: Run, n: number) =>
  readFileSync(join(run.target.tmpDir, `plan-prompt-${n}.txt`), 'utf8');

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
  trustHome = useTrustHome('question-over-draft');
});

afterEach(() => {
  trustHome.restore();
});

// The run starts and the first planner call holds, so the composer is live while the planner runs.
async function scenario(drive: (run: Run, tui: Tui) => Promise<void>) {
  const run = setup();
  try {
    await inTui(run, trustHome.home, async (tui) => {
      await expect.poll(tui.screen, PATIENCE).toContain('Describe your feature');
      tui.write('add a total helper');
      await expect.poll(tui.screen, PATIENCE).toContain('› add a total helper');
      tui.write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(planCalls(run)).toBe(1), PATIENCE);
      await drive(run, tui);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

// The panel drops the keys of its grace after it opens, and it paints after it opens.
async function pastGrace() {
  const painted = Date.now();
  await vi.waitFor(
    () => expect(Date.now() - painted).toBeGreaterThan(PROMPT_TYPEAHEAD_GRACE_MS),
    PATIENCE,
  );
}

it(
  'leaves the keys in the composer when a planner question opens over a draft',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, { screen, write }) => {
      write(DRAFT);
      await expect.poll(screen, PATIENCE).toContain(`› ${DRAFT}`);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(QUESTION_PANEL);
      await expect.poll(screen, PATIENCE).toMatch(/Questions paused|send answers/);
      expect(screen()).toContain('Questions paused · tab to return · esc type a reply');

      write(' in the second helper');
      await expect.poll(screen, PATIENCE).toContain(`› ${DRAFT} in the second helper`);
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(planCalls(run)).toBe(2), PATIENCE);
      const prompt = planPrompt(run, 2);
      expect(prompt).toContain(`${DRAFT} in the second helper`);
      expect(prompt).not.toMatch(new RegExp(`^${DEFAULT_ANSWER}$`, 'm'));
    });
  },
);

it(
  'gives a planner question the keys when it opens over an empty composer',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, { screen, write }) => {
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(`▌ ${DEFAULT_ANSWER}`);
      await pastGrace();

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(planCalls(run)).toBe(2), PATIENCE);
      expect(planPrompt(run, 2)).toMatch(new RegExp(`^${DEFAULT_ANSWER}$`, 'm'));
    });
  },
);

// ⏎ runs the /steer line that the composer holds over the waiting question.
async function steerAnswersQuestion(run: Run, { screen, write }: Tui) {
  writeFileSync(run.planHold, '');
  write(PTY_SUBMIT_INPUT);
  await vi.waitFor(
    () => expect(planCalls(run) === 2 || screen().includes(STOPPED)).toBe(true),
    PATIENCE,
  );
  expect(screen()).not.toContain(STOPPED);
  const prompt = planPrompt(run, 2);
  expect(prompt).toContain(DRAFT);
  expect(prompt).not.toContain('/steer');
  expect(prompt).not.toMatch(new RegExp(`^${DEFAULT_ANSWER}$`, 'm'));

  await expect.poll(screen, PATIENCE).toContain('Answered · 1 question');
  const answered = screen();
  expect(answered).toContain('Answered · 1 question');
  expect(answered).toContain(DRAFT);
  unlinkSync(run.planHold);

  await expect.poll(screen, PATIENCE).toContain(PLAN_CARD);
  expect(screen()).not.toContain(STOPPED);
}

it(
  'sends the words of /steer as the answer when the question opens over the typed line',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      write(`/steer ${DRAFT}`);
      await expect.poll(screen, PATIENCE).toContain(`› /steer ${DRAFT}`);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(QUESTION_PANEL);
      await expect.poll(screen, PATIENCE).toContain('Questions paused');

      await steerAnswersQuestion(run, tui);
    });
  },
);

it(
  'sends the words of /steer as the answer when the line is typed over the open question',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, tui) => {
      const { screen, write } = tui;
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(`▌ ${DEFAULT_ANSWER}`);
      await pastGrace();
      write(`/steer ${DRAFT}`);
      await expect.poll(screen, PATIENCE).toContain(`› /steer ${DRAFT}`);
      await expect.poll(screen, PATIENCE).toContain('Questions paused');

      await steerAnswersQuestion(run, tui);
    });
  },
);

it(
  'keeps a command that SPLITBRIEF refuses in the answer field, over a composer draft',
  SCENARIO_TIMEOUT,
  async () => {
    await scenario(async (run, { screen, write }) => {
      write(DRAFT);
      await expect.poll(screen, PATIENCE).toContain(`› ${DRAFT}`);
      unlinkSync(run.hold);
      await expect.poll(screen, PATIENCE).toContain(QUESTION_PANEL);
      await expect.poll(screen, PATIENCE).toContain('Questions paused');
      await pastGrace();
      write('\t');
      await expect.poll(screen, PATIENCE).toContain(`▌ ${DEFAULT_ANSWER}`);
      write('\t');
      await expect.poll(screen, PATIENCE).toContain('↑/tab menu');
      write(MISTYPED);
      await expect.poll(screen, PATIENCE).toContain(`› ${MISTYPED}`);

      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, PATIENCE).toContain('Unknown command: /ster. Did you mean /steer?');
      await expect.poll(screen, { timeout: 15_000 }).toContain(`› ${MISTYPED}`);
      expect(screen()).toContain('↑/tab menu');
      expect(screen()).toContain(`› ${DRAFT}`);
      expect(planCalls(run)).toBe(1);
    });
  },
);
