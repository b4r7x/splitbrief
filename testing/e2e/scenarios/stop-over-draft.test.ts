import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionDir } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { resolveTheme } from '../../../src/core/theme/resolve.js';
import { STOP_SHEET_PARKED_LEGEND } from '../../../src/features/workflow/stop/options.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
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
const ENTER = '\r';
const SHIFT_ENTER = '\x1b[13;2u';
const STOPPED = '○ Stopped at the review';
const WORDS = 'also fix the typo';
// The child runs with FORCE_COLOR=3 and no answer to the background query, so its screen paints the
// dark palette in truecolor.
const SCREEN_THEME = resolveTheme({ variant: 'dark', level: 3, terminalBackground: undefined });
const TWO_LINE_DRAFT = [WORDS, 'and add the missing test'] as const;

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
const REVIEW_REPLY = JSON.stringify(
  passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] }),
);

/** The first final review traps SIGTERM and ends when `release` exists; a later one answers. */
function plannerScript(reviewCalls: string, reviewPrompts: string, release: string): string {
  return `import { appendFileSync, existsSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const kind = prompt.includes('# Final Implementation Review')
  ? 'final-review'
  : prompt.includes('# Plan the change')
    ? 'plan'
    : 'other';
if (kind === 'plan') {
  process.stdout.write(JSON.stringify(${JSON.stringify({ result: plan })}));
} else {
  if (kind !== 'final-review') throw new Error('Unexpected prompt: ' + prompt);
  appendFileSync(${JSON.stringify(reviewPrompts)}, prompt);
  const held = !existsSync(${JSON.stringify(release)});
  if (held) process.on('SIGTERM', () => {});
  appendFileSync(${JSON.stringify(reviewCalls)}, 'final-review\\n');
  if (held) {
    const deadline = Date.now() + 120000;
    while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    process.exit(143);
  }
  process.stdout.write(${JSON.stringify(REVIEW_REPLY)});
}
`;
}

function implementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, 'export const total = (a, b) => a + b;\\n');
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, "import { strict as assert } from 'node:assert';\\nimport { test } from 'node:test';\\nimport { total } from './total.mjs';\\ntest('total adds', () => assert.equal(total(1, 2), 3));\\n");
console.log('Implemented');
`;
}

function prepareRun() {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  const reviewCalls = join(target.tmpDir, 'review-calls.txt');
  const reviewPrompts = join(target.tmpDir, 'review-prompts.txt');
  const release = join(target.tmpDir, 'release');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(reviewCalls, '');
  writeFileSync(reviewPrompts, '');
  writeFileSync(plannerPath, plannerScript(reviewCalls, reviewPrompts, release));
  writeFileSync(implementerPath, implementerScript());
  writeFileSync(offlinePath, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
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
  return {
    target,
    offlinePath,
    release: () => writeFileSync(release, ''),
    reviewCalls: () => readFileSync(reviewCalls, 'utf8').split('\n').filter(Boolean).length,
    reviewPrompts: () => readFileSync(reviewPrompts, 'utf8'),
  };
}

type Run = ReturnType<typeof prepareRun>;
type Tui = Readonly<{
  screen: () => string;
  write: (keys: string) => void;
  foregroundAt: (phrase: string, offset?: number) => TerminalForeground;
}>;

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

/**
 * Runs to the final review and chooses Stop now, with the tool still holding the stop open.
 * A draft is typed before Esc: the kill timer of the stop starts only after Stop now.
 */
async function whileReviewStops(
  home: string,
  drive: (tui: Tui, run: Run) => Promise<void>,
  draft?: readonly string[],
): Promise<void> {
  const run = prepareRun();
  try {
    await inTui(run, home, async (tui) => {
      const { screen, write } = tui;
      await expect.poll(screen, RUN).toContain('Describe your feature');
      write('add a total helper');
      await expect.poll(screen, PAINT).toContain('› add a total helper');
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(run.reviewCalls()).toBe(1), RUN);
      if (draft !== undefined) {
        for (const [index, line] of draft.entries()) {
          if (index > 0) write(SHIFT_ENTER);
          write(line);
          await expect.poll(screen, PAINT).toContain(index === 0 ? `› ${line}` : line);
        }
      }
      write('\x1b');
      await expect.poll(screen, PAINT).toContain('Stop now');
      await moveCursorTo(screen, write, '\x1b[B', /▌ Stop now/);
      write(ENTER);
      await expect.poll(screen, PAINT).toContain('esc back after stop');
      await drive(tui, run);
    });
  } finally {
    cleanupTempDir(run.target.tmpDir);
  }
}

describe('e2e: a stop that settles under text typed in the composer', {
  timeout: 180_000,
}, () => {
  let trustHome: ReturnType<typeof useTrustHome>;

  beforeEach(() => {
    trustHome = useTrustHome('stop-over-draft');
  });

  afterEach(() => {
    trustHome.restore();
  });

  it('leaves a sentence typed before the stop in the composer, and ⏎ continues the run with the words', async () => {
    await whileReviewStops(
      trustHome.home,
      async ({ screen, write }, run) => {
        expect(screen()).toContain(`› ${WORDS}`);
        run.release();
        await expect.poll(screen, PAINT).toContain(STOPPED);
        expect(screen()).not.toContain('Session options');
        expect(screen()).toContain('⏎ resume');
        expect(screen()).toContain(`› ${WORDS}`);

        write(ENTER);
        await vi.waitFor(() => expect(run.reviewCalls()).toBe(2), RUN);
        expect(run.reviewPrompts()).toContain(WORDS);
      },
      [WORDS],
    );
  });

  it('runs a command typed during the stop and leaves the run stopped', async () => {
    await whileReviewStops(trustHome.home, async ({ screen, write }, run) => {
      write('/crew');
      await expect.poll(screen, PAINT).toContain('▌ /crew  Who fills each seat');
      run.release();
      await expect.poll(screen, PAINT).toContain(STOPPED);

      write(ENTER);
      await vi.waitFor(() => expect(/▌ PLAN/.test(screen()) || run.reviewCalls() > 1).toBe(true), {
        timeout: 30_000,
      });
      expect(run.reviewCalls()).toBe(1);
      expect(screen()).toMatch(/▌ PLAN/);
    });
  });

  it('keeps the sentence and the sheet closed when the stop fails, and the byline names the failure', async () => {
    await whileReviewStops(
      trustHome.home,
      async ({ screen }, run) => {
        const sessionId = readActive(run.target.projectDir);
        if (sessionId === null) throw new Error('no active session');
        const dir = sessionDir(run.target.projectDir, sessionId);
        chmodSync(dir, 0o555);
        try {
          run.release();
          await expect.poll(screen, PAINT).toMatch(/Stop failed|Retry stop/);
          expect(screen()).not.toContain('Stop options');
          expect(screen()).toContain('Stop failed · ');
          expect(screen()).toContain(`› ${WORDS}`);
        } finally {
          chmodSync(dir, 0o755);
        }
      },
      [WORDS],
    );
  });

  it('shows both draft lines on their own rows under the parked session options', async () => {
    await whileReviewStops(
      trustHome.home,
      async ({ screen, write }, run) => {
        run.release();
        await expect.poll(screen, PAINT).toContain(STOPPED);
        write('\x0b');
        await expect.poll(screen, PAINT).toContain('Type a command…');
        write('stop');
        await expect.poll(screen, PAINT).toMatch(/▌ \/stop/);
        write(ENTER);
        await expect.poll(screen, PAINT).toContain('Session options');
        await expect.poll(screen, PAINT).toContain(TWO_LINE_DRAFT[1]);

        const parked = screen();
        expect(parked).toContain('Session options');
        expect(parked).toContain('Resume');
        expect(parked).toContain('End run');
        expect(parked).toContain('Back to sessions');
        expect(parked).toContain(STOP_SHEET_PARKED_LEGEND);
        const rows = parked.split('\n').map((row) => row.trimEnd());
        const first = rows.find((row) => row.includes(TWO_LINE_DRAFT[0])) ?? '';
        const second = rows.find((row) => row.includes(TWO_LINE_DRAFT[1])) ?? '';
        expect(first).toContain(`› ${TWO_LINE_DRAFT[0]}`);
        expect(first).not.toContain(TWO_LINE_DRAFT[1]);
        expect(second).toContain(TWO_LINE_DRAFT[1]);
        expect(second).not.toContain(TWO_LINE_DRAFT[0]);
      },
      TWO_LINE_DRAFT,
    );
  });

  it('marks a draft that cannot be saved with the failed mark', async () => {
    await whileReviewStops(trustHome.home, async ({ screen, write, foregroundAt }, run) => {
      const sessionId = readActive(run.target.projectDir);
      if (sessionId === null) throw new Error('no active session');
      const dir = sessionDir(run.target.projectDir, sessionId);
      chmodSync(dir, 0o555);
      try {
        write('!');
        const row = `${glyph('statusFailed', 'unicode')} Draft not saved`;
        await expect.poll(screen, PAINT).toContain(row);
        const mark = foregroundAt(row);
        const firstLetter = foregroundAt(row, row.indexOf('Draft not saved'));
        expect(mark).not.toEqual(firstLetter);
        expect(mark).toEqual({ mode: 'rgb', color: SCREEN_THEME.error });
        expect(firstLetter).toEqual({ mode: 'rgb', color: SCREEN_THEME.text });
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  });

  it('opens the sheet over an empty composer, and ⏎ takes Resume', async () => {
    await whileReviewStops(trustHome.home, async ({ screen, write }, run) => {
      run.release();
      await expect.poll(screen, PAINT).toContain('Session options');
      expect(screen()).toMatch(/▌ Resume/);

      write(ENTER);
      await vi.waitFor(() => expect(run.reviewCalls()).toBe(2), RUN);
    });
  });
});
