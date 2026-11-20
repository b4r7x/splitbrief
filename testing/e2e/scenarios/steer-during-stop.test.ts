import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { resolveTheme } from '../../../src/core/theme/resolve.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { acrossNoticeEdges } from '#testing/helpers/notice-text.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { createStopContinueFixture } from '../helpers/stop-continue-fixture.js';
import { readForegroundAtText, type TerminalForeground } from '../helpers/terminal-cells.js';
import { wholeFrames } from '../helpers/whole-frames.js';

const VIEWPORT = { cols: 120, rows: 40 };
const PAINT = { timeout: 15_000 };
const RUN = { timeout: 120_000 };
const WORDS = 'also fix the typo';
const LINE = `/steer ${WORDS}`;
const STOP_REASON = 'Finish stopping before steering.';
const NO_RUN_REASON = 'Nothing to steer.';
const SCREEN_THEME = resolveTheme({ variant: 'dark', level: 3, terminalBackground: undefined });

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

type Tui = Readonly<{
  screen: () => string;
  write: (keys: string) => void;
  foregroundAt: (phrase: string, offset?: number) => TerminalForeground;
}>;

function plannerScript(): string {
  return `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  process.stdout.write(${JSON.stringify(REVIEW_REPLY)});
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
}
`;
}

// The first BUILD call does not end on SIGTERM, so the stop stays open until the run kills the
// call. Each call saves its prompt and sets its trap before it is counted.
function implementerScript(callsPath: string, dir: string): string {
  return `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const n = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter(Boolean).length + 1;
writeFileSync(${JSON.stringify(dir)} + '/build-prompt-' + n + '.txt', Buffer.concat(chunks).toString('utf8'));
if (n === 1) process.on('SIGTERM', () => {});
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
if (n === 1) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  process.exit(143);
}
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented');
`;
}

function setup() {
  const target = createStopContinueFixture(() => '');
  const calls = join(target.tmpDir, 'calls.txt');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(calls, '');
  writeFileSync(plannerPath, plannerScript());
  writeFileSync(implementerPath, implementerScript(calls, target.tmpDir));
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
  return { target, offlinePath, calls };
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
      const frames = wholeFrames((data) => terminal.write(data));
      const dataListener = child.onData(frames.feed);
      const exitListener = child.onExit((event) => {
        frames.flush();
        outcome = event;
        exit.resolve(event);
      });
      try {
        await drive({
          screen,
          write: (keys) => child.write(keys),
          foregroundAt: (phrase, offset) =>
            readForegroundAtText(terminal.buffer.active, phrase, offset),
        });
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
  trustHome = useTrustHome('steer-during-stop');
});

afterEach(() => {
  trustHome.restore();
});

it('names the stop as the reason when /steer runs before the run stopped, and steers after it', {
  timeout: 200_000,
}, async () => {
  const run = setup();
  try {
    await inTui(run, trustHome.home, async ({ screen, write, foregroundAt }) => {
      await expect.poll(screen, RUN).toContain('Describe your feature');
      write('add a total helper');
      await expect.poll(screen, PAINT).toContain('› add a total helper');
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(buildCalls(run)).toBe(1), RUN);

      // The line is typed before Esc: the kill timer of the stop starts only after Stop now.
      write(LINE);
      await expect.poll(screen, PAINT).toContain(`› ${LINE}`);
      write('\x1b');
      await expect.poll(screen, PAINT).toContain('Stop now');
      await moveCursorTo(screen, write, '\x1b[B', /▌ Stop now/);
      write('\r');
      await expect.poll(screen, PAINT).toContain('esc back after stop');

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(
        () => expect(screen().includes(STOP_REASON) || screen().includes(NO_RUN_REASON)).toBe(true),
        PAINT,
      );
      expect(screen()).not.toContain(NO_RUN_REASON);
      expect(screen()).toContain(STOP_REASON);
      const firstLetter = foregroundAt(STOP_REASON, 0);
      expect(firstLetter).toEqual(foregroundAt(STOP_REASON, 'Finish '.length));
      expect(firstLetter).toEqual({ mode: 'rgb', color: SCREEN_THEME.text });
      expect(screen()).toContain(`› ${LINE}`);

      await expect.poll(screen, PAINT).toContain('○ Stopped at T001');
      expect(screen()).not.toContain(NO_RUN_REASON);
      expect(screen()).toContain(`› ${LINE}`);
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(buildCalls(run)).toBe(2), RUN);
      expect(buildPrompt(run, 2)).toContain(WORDS);
      expect(screen()).not.toContain(NO_RUN_REASON);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
});

// The notice of the queue, read inside its frame: the transcript row of the same message names its timing.
const queueNotice = (text: string) =>
  text
    .split('\n')
    .map((line) => acrossNoticeEdges(line).trim())
    .find((line) => line.startsWith('Queued for BUILD on T001') && !line.includes('· read'));

it('names no key in the queue notice when ⏎ sends words before the run stopped', {
  timeout: 200_000,
}, async () => {
  const run = setup();
  try {
    await inTui(run, trustHome.home, async ({ screen, write }) => {
      await expect.poll(screen, RUN).toContain('Describe your feature');
      write('add a total helper');
      await expect.poll(screen, PAINT).toContain('› add a total helper');
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(buildCalls(run)).toBe(1), RUN);

      // The words are typed before Esc: the kill timer of the stop starts only after Stop now.
      write(WORDS);
      await expect.poll(screen, PAINT).toContain(`› ${WORDS}`);
      write('\x1b');
      await expect.poll(screen, PAINT).toContain('Stop now');
      await moveCursorTo(screen, write, '\x1b[B', /▌ Stop now/);
      write('\r');
      await expect.poll(screen, PAINT).toContain('esc back after stop');

      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(queueNotice(screen())).toBeDefined(), PAINT);
      expect(screen()).toContain('Stopping T001');
      expect(queueNotice(screen())).toBe('Queued for BUILD on T001');
      expect(screen()).not.toContain('ctrl+⏎');

      await expect.poll(screen, PAINT).toContain('○ Stopped at T001');
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(buildCalls(run)).toBe(2), RUN);
      expect(buildPrompt(run, 2)).toContain(WORDS);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
});
