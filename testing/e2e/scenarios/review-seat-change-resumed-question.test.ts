import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { beforeAll, expect, it, vi } from 'vitest';
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
import { buildSteeringCli } from '../helpers/steer-e2e-workflow.js';
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
  /** The count of `codex exec` calls. */
  codexCalls: string;
  /** The prompt of the last `codex exec` call. */
  codexPrompt: string;
}>;

/** The REVIEW seat the run starts on. Call 1 asks the question; a later call passes with the answer rejected. */
function shellReviewerScript(files: ReviewFiles): string {
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
const countPath = ${JSON.stringify(files.shellCalls)};
const call = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(call));
console.log(call === 1 ? ${JSON.stringify(ASKING_VERDICT)} : ${JSON.stringify(ANSWERED_VERDICT)});
`;
}

/** The REVIEW seat the user saves: a codex that counts its calls, keeps its prompt and passes. */
function installCodex(binDir: string, files: ReviewFiles): void {
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
const emit = (entry) => console.log(JSON.stringify(entry));
emit({ type: 'thread.started', thread_id: 'review-seat-change-' + call });
emit({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(ANSWERED_VERDICT)} } });
emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } });`,
  );
}

function callCount(path: string): number {
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
}

type Terminal = Readonly<{
  screen: () => string;
  write: (keys: string) => void;
  shows: (expected: string | RegExp) => Promise<void>;
  outcome: () => PtyExitEvent | undefined;
}>;

beforeAll(buildSteeringCli, 120_000);

it('runs the review after the answer on the REVIEW seat saved while a continued run asks its question again', {
  timeout: 240_000,
}, async () => {
  const target = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'none' });
  const trustHome = createTrustHome('e2e-review-seat-change-resumed-home');
  const files: ReviewFiles = {
    shellCalls: join(target.tmpDir, 'shell-review-calls'),
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
    installCodex(binDir, files);
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
      role: 'planner',
    });
    expect(tools[0]?.diagnostic.state).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in review seat change E2E'); };\n",
    );

    const drive = (argv: readonly string[], steps: (terminal: Terminal) => Promise<void>) =>
      runWithPtyChild(
        {
          requirement: 'required',
          argv: [
            '--import',
            offline,
            'dist/cli.js',
            ...argv,
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
          const shows = (expected: string | RegExp) =>
            vi.waitFor(
              () =>
                typeof expected === 'string'
                  ? expect(screen()).toContain(expected)
                  : expect(screen()).toMatch(expected),
              WAIT,
            );
          const dataListener = child.onData((data) => terminal.write(data));
          const exitListener = child.onExit((event) => {
            outcome = event;
            exit.resolve(event);
          });
          try {
            await steps({
              screen,
              write: (keys) => child.write(keys),
              shows,
              outcome: () => outcome,
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
    const quit = async ({ write, outcome }: Terminal) => {
      write('\x11');
      await expect.poll(outcome, WAIT).toBeDefined();
      expect(outcome()?.exitCode).toBe(0);
    };

    await drive(['start', 'smoke'], async (terminal) => {
      await terminal.shows(QUESTION);
      await quit(terminal);
    });

    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    let lastScreen = '';
    await drive(['continue', sessionId], async (terminal) => {
      const { screen, write, shows } = terminal;
      await shows(QUESTION);
      await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
      write('/crew review');
      await shows('/crew review');
      write('\r');
      await shows('REVIEW · tool, model, effort');
      await moveCursorTo(screen, write, '\x1b[B', /▌ OpenAI Codex CLI/);
      write('\r');
      await shows(/▌ auto +tool decides/);
      write('\r');
      await expect
        .poll(() => loadConfig(target.projectDir).config.reviewer, WAIT)
        .toMatchObject({ kind: 'cli', tool: 'codex' });
      await vi.waitFor(() => expect(screen()).not.toContain('REVIEW · tool, model, effort'), WAIT);

      await shows(QUESTION);
      await delay(PROMPT_TYPEAHEAD_GRACE_MS * 2);
      write(ANSWER);
      await shows(ANSWER);
      write('\r');

      await shows('Final review re-run passed');
      await expect
        .poll(
          async () =>
            (await readRunEvents({ projectDir: target.projectDir, sessionId })).events.some(
              (event) => event.type === 'workflow_complete',
            ),
          WAIT,
        )
        .toBe(true);
      lastScreen = screen();
      await quit(terminal);
    });

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.filter((event) => event.type === 'review_started').map((event) => event.tool),
    ).toEqual(['shell', 'codex']);
    expect(callCount(files.shellCalls)).toBe(1);
    expect(callCount(files.codexCalls)).toBe(1);
    expect(
      events.filter((event) => event.type === 'turn_interrupted' && event.cause === 'seat-change'),
    ).toEqual([expect.objectContaining({ at: 'boundary', step: { kind: 'review', cycle: 0 } })]);
    expect(events.filter((event) => event.type === 'seat_switched')).toEqual([
      expect.objectContaining({ seat: 'review', cause: 'crew-changed', auto: false }),
    ]);
    const prompt = readFileSync(files.codexPrompt, 'utf8');
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain(ANSWER);
    expect(lastScreen).toContain(HEADER_REVIEW_SEAT);
  } finally {
    restorePath?.();
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
