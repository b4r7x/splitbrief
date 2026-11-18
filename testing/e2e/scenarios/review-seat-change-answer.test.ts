import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 120;
const ROWS = 40;
const WAIT = { timeout: 45_000, interval: 20 };

const QUESTION = 'Keep the lowercase greeting?';
const ANSWER = 'KEEP_LOWERCASE';
const SAVE_TEXT = 'REVIEW seat changes at the next review or fix brief';
const LEGEND_TEXT = 'Seat changes at the next review or fix brief';
/** The header names the seat that the run uses: the saved Codex seat, with the model left to the tool. */
const HEADER_REVIEW_SEAT = 'REVIEW OpenAI Codex CLI';

/** The fixture plan's one task and one criterion (`createStopContinueFixture`'s typed plan). */
const VERDICT = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
const ASKING_VERDICT = JSON.stringify({
  ...VERDICT,
  ask: { question: QUESTION, whyOnlyUserCanAnswer: 'The user chooses the casing.' },
});
/** The answer is pending input `A1`; it needs no work, so the review rejects it. */
const ANSWERED_VERDICT = JSON.stringify({
  ...VERDICT,
  rejected: [{ findingId: 'A1', reason: 'The answer keeps the greeting as built.' }],
});

const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`;

type ReviewFiles = Readonly<{
  /** The count of calls of the shell reviewer. */
  shellCalls: string;
  /** Written by the shell reviewer when its first call has its prompt. */
  started: string;
  /** The first call of the shell reviewer holds its verdict until this file exists. */
  release: string;
  /** The count of `codex exec` calls. */
  codexCalls: string;
  /** The prompt of the last `codex exec` call. */
  codexPrompt: string;
}>;

/**
 * The REVIEW seat the run starts on. Call 1 holds its verdict, so the user can save another seat
 * while the review runs, and then asks the question. A later call passes with the answer rejected.
 */
function shellReviewerScript(files: ReviewFiles): string {
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
const countPath = ${JSON.stringify(files.shellCalls)};
const call = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(call));
if (call === 1) {
  writeFileSync(${JSON.stringify(files.started)}, '');
  while (!existsSync(${JSON.stringify(files.release)})) await delay(25);
  console.log(${JSON.stringify(ASKING_VERDICT)});
} else {
  console.log(${JSON.stringify(ANSWERED_VERDICT)});
}
`;
}

/**
 * A codex REVIEW seat that counts its calls, keeps its prompt and gives `verdict`. With `hold`, its
 * first call writes `files.started` and holds its verdict until `files.release` exists.
 */
function installCodex(
  binDir: string,
  files: ReviewFiles,
  verdict: string,
  hold: 'hold-first-call' | 'no-hold',
): void {
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected codex invocation: ' + args.join(' '));
const prompt = readFileSync(0, 'utf8');
const countPath = ${JSON.stringify(files.codexCalls)};
const call = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(call));
writeFileSync(${JSON.stringify(files.codexPrompt)}, prompt);
if (${JSON.stringify(hold === 'hold-first-call')} && call === 1) {
  writeFileSync(${JSON.stringify(files.started)}, '');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(files.release)})) Atomics.wait(pause, 0, 0, 25);
}
const emit = (entry) => console.log(JSON.stringify(entry));
emit({ type: 'thread.started', thread_id: 'review-seat-change-' + call });
emit({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(verdict)} } });
emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } });`,
  );
}

function callCount(path: string): number {
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
}

it('runs the review again on the REVIEW seat that the user saved while the first review ran', {
  timeout: 240_000,
}, async () => {
  const target = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'none' });
  const trustHome = createTrustHome('e2e-review-seat-change-home');
  const files: ReviewFiles = {
    shellCalls: join(target.tmpDir, 'shell-review-calls'),
    started: join(target.tmpDir, 'review-1-started'),
    release: join(target.tmpDir, 'release-1'),
    codexCalls: join(target.tmpDir, 'codex-calls'),
    codexPrompt: join(target.tmpDir, 'codex-prompt'),
  };
  let restorePath: (() => void) | undefined;
  try {
    const hostCodex = join(trustHome.home, '.codex');
    mkdirSync(join(hostCodex, 'sessions'), { recursive: true });
    writeFileSync(
      join(hostCodex, 'auth.json'),
      '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture"}}\n',
    );
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(binDir);
    installCodex(binDir, files, ANSWERED_VERDICT, 'no-hold');
    restorePath = activateSafeCliShimPath(binDir);
    const reviewer = join(target.tmpDir, 'reviewer.mjs');
    writeFileSync(reviewer, shellReviewerScript(files));
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      validation: { ...config.validation, endChecks: true },
      reviewer: {
        kind: 'shell',
        command: process.execPath,
        args: [reviewer],
        outputFormat: 'text',
      },
    });
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trustHome.home, [binDir]),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: env.PATH ?? '',
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex'],
    });
    expect(tools[0]?.diagnostic.state).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in review seat change E2E'); };\n",
    );

    let sessionId = '';
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          offline,
          'dist/cli.js',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO_ROOT, env },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          cols: COLS,
          rows: ROWS,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: ROWS },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const write = (keys: string) => child.write(keys);
        const shows = (expected: string | RegExp) =>
          vi.waitFor(
            () =>
              typeof expected === 'string'
                ? expect(screen()).toContain(expected)
                : expect(screen()).toMatch(expected),
            WAIT,
          );
        /**
         * Waits for a seat change text. The row stays in `seen` after the screen drops it, so a
         * failure names the words that the screen showed in place of the expected ones.
         */
        const showsSeatChange = (subject: string, expected: string) => {
          let seen: string | undefined;
          return vi.waitFor(() => {
            const row = screen()
              .split('\n')
              .find((line) => line.includes(`${subject} changes `));
            seen = row?.trim() ?? seen;
            expect(seen ?? screen()).toContain(expected);
          }, WAIT);
        };
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(() => existsSync(files.started), WAIT).toBe(true);
          await shows('reviewing changes');

          write('/crew review');
          await shows('/crew review');
          write('\r');
          await shows('REVIEW · tool, model, effort');
          await moveCursorTo(screen, write, '\x1b[B', /▌ OpenAI Codex CLI/);
          write('\r');
          await shows(/▌ auto +tool decides/);
          write('\r');
          await showsSeatChange('REVIEW seat', SAVE_TEXT);
          await showsSeatChange('Seat', LEGEND_TEXT);

          writeFileSync(files.release, '');
          await shows(QUESTION);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
          write(ANSWER);
          await shows(ANSWER);
          write('\r');

          await shows('Final review re-run passed');
          const runSession = readdirSync(sessionsRoot(target.projectDir))[0];
          if (runSession === undefined) throw new Error('CLI started without a run');
          sessionId = runSession;
          await expect
            .poll(
              async () =>
                (await readRunEvents({ projectDir: target.projectDir, sessionId })).events.some(
                  (event) => event.type === 'workflow_complete',
                ),
              WAIT,
            )
            .toBe(true);
          expect(screen()).toContain(HEADER_REVIEW_SEAT);

          write('\x11');
          await expect.poll(() => outcome, WAIT).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } finally {
          writeFileSync(files.release, '');
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(callCount(files.codexCalls)).toBe(1);
    expect(callCount(files.shellCalls)).toBe(1);
    expect(
      events.filter((event) => event.type === 'turn_interrupted' && event.cause === 'seat-change'),
    ).toEqual([expect.objectContaining({ at: 'boundary', step: { kind: 'review', cycle: 0 } })]);
    expect(
      events.filter((event) => event.type === 'workflow_resumed' && event.cause === 'seat-change'),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'seat_switched')).toEqual([
      expect.objectContaining({ seat: 'review', cause: 'crew-changed', auto: false }),
    ]);
    expect(
      events.filter((event) => event.type === 'review_started').map((event) => event.tool),
    ).toEqual(['shell', 'codex']);
    const prompt = readFileSync(files.codexPrompt, 'utf8');
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain(ANSWER);
    expect(prompt).toContain(GREET_FILE);
  } finally {
    restorePath?.();
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});

it('keeps the review on the REVIEW seat of the run when the user saves another seat and then saves it back', {
  timeout: 240_000,
}, async () => {
  const target = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'none' });
  const trustHome = createTrustHome('e2e-review-seat-saved-back-home');
  const files: ReviewFiles = {
    shellCalls: join(target.tmpDir, 'shell-review-calls'),
    started: join(target.tmpDir, 'review-1-started'),
    release: join(target.tmpDir, 'release-1'),
    codexCalls: join(target.tmpDir, 'codex-calls'),
    codexPrompt: join(target.tmpDir, 'codex-prompt'),
  };
  let restorePath: (() => void) | undefined;
  try {
    const hostCodex = join(trustHome.home, '.codex');
    mkdirSync(join(hostCodex, 'sessions'), { recursive: true });
    writeFileSync(
      join(hostCodex, 'auth.json'),
      '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture"}}\n',
    );
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(binDir);
    installCodex(binDir, files, JSON.stringify(VERDICT), 'hold-first-call');
    restorePath = activateSafeCliShimPath(binDir);
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      validation: { ...config.validation, endChecks: true },
      reviewer: { kind: 'cli', tool: 'codex' },
    });
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trustHome.home, [binDir]),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: env.PATH ?? '',
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex'],
    });
    expect(tools[0]?.diagnostic.state).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in review seat change E2E'); };\n",
    );

    let sessionId = '';
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          offline,
          'dist/cli.js',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: REPO_ROOT, env },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          cols: COLS,
          rows: ROWS,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: ROWS },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const write = (keys: string) => child.write(keys);
        const shows = (expected: string | RegExp) =>
          vi.waitFor(
            () =>
              typeof expected === 'string'
                ? expect(screen()).toContain(expected)
                : expect(screen()).toMatch(expected),
            WAIT,
          );
        /**
         * Waits for a seat change text. The row stays in `seen` after the screen drops it, so a
         * failure names the words that the screen showed in place of the expected ones.
         */
        const showsSeatChange = (subject: string, expected: string) => {
          let seen: string | undefined;
          return vi.waitFor(() => {
            const row = screen()
              .split('\n')
              .find((line) => line.includes(`${subject} changes `));
            seen = row?.trim() ?? seen;
            expect(seen ?? screen()).toContain(expected);
          }, WAIT);
        };
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(() => existsSync(files.started), WAIT).toBe(true);
          await shows('reviewing changes');

          write('/crew review');
          await shows('/crew review');
          write('\r');
          await shows('REVIEW · tool, model, effort');
          await moveCursorTo(screen, write, '\x1b[B', /▌ = PLAN/);
          write('\r');
          await showsSeatChange('REVIEW seat', SAVE_TEXT);
          await showsSeatChange('Seat', LEGEND_TEXT);

          write('/crew review');
          await shows('/crew review');
          write('\r');
          await shows('REVIEW · tool, model, effort');
          await moveCursorTo(screen, write, '\x1b[A', /▌ OpenAI Codex CLI/);
          write('\r');
          await shows(/▌ auto +tool decides/);
          write('\r');
          await shows(/Saved REVIEW · OpenAI Codex CLI/);
          await vi.waitFor(() => expect(screen()).not.toContain(LEGEND_TEXT), WAIT);

          writeFileSync(files.release, '');
          const runSession = readdirSync(sessionsRoot(target.projectDir))[0];
          if (runSession === undefined) throw new Error('CLI started without a run');
          sessionId = runSession;
          await expect
            .poll(
              async () =>
                (await readRunEvents({ projectDir: target.projectDir, sessionId })).events.some(
                  (event) => event.type === 'workflow_complete',
                ),
              WAIT,
            )
            .toBe(true);
          expect(screen()).toContain(HEADER_REVIEW_SEAT);

          write('\x11');
          await expect.poll(() => outcome, WAIT).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } finally {
          writeFileSync(files.release, '');
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(callCount(files.codexCalls)).toBe(1);
    expect(
      events.filter(
        (event) =>
          (event.type === 'turn_interrupted' || event.type === 'workflow_resumed') &&
          event.cause === 'seat-change',
      ),
    ).toEqual([]);
    expect(events.filter((event) => event.type === 'seat_switched')).toEqual([]);
    expect(
      events.filter((event) => event.type === 'review_started').map((event) => event.tool),
    ).toEqual(['codex']);
  } finally {
    restorePath?.();
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
