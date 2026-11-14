import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { transcriptText } from '../helpers/transcript-text.js';
import {
  createStopContinueFixture,
  findMarker,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const COMMAND_CODE_STATUS = readFileSync(
  join(import.meta.dirname, '../../fixtures/command-code/status.txt'),
  'utf8',
)
  .split(/\r?\n/u)
  .slice(2)
  .join('\n');

const VIEWPORT = { cols: 120, rows: 40 };

const RETRY_SENTENCE = 'Network or server failure · retry 1 of 10 in 2s';
const RETRY_PHRASE = 'Network or server failure';

/** The same window the retry used to be polled through: one observation, not a longer timeout. */
const OBSERVATION_TIMEOUT_MS = 120_000;

/**
 * A fake Command Code CLI whose first BUILD call drops its connection and whose second one writes
 * the brief's files. Every invocation's argv is recorded outside the project, so a readiness probe
 * can be told from a BUILD call; only the calls that carry `-p` count as BUILD invocations.
 */
function fakeCommandCodeScript(invocationsPath: string, argvPath: string): string {
  return `const { appendFileSync, mkdirSync, readFileSync, writeSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) {
  console.log('${CLI_TOOL_CATALOG['command-code'].compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'status') {
  console.log(${JSON.stringify(COMMAND_CODE_STATUS)});
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Command Code fixture');
  process.exit(0);
}
if (!args.includes('-p')) process.exit(1);
readFileSync(0, 'utf8');
const countPath = ${JSON.stringify(invocationsPath)};
let runs = 0;
try {
  runs = Number(readFileSync(countPath, 'utf8')) || 0;
} catch {}
writeFileSync(countPath, String(runs + 1));
if (runs === 0) {
  writeSync(2, 'socket hang up\\n');
  writeSync(1, JSON.stringify({ type: 'result', subtype: 'error', error: 'socket hang up' }) + '\\n');
  process.exit(1);
}
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'result', subtype: 'success', sessionId: 'command-code-seat-retry', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 10, finalText: 'Implemented the greeting.' }));
`;
}

/** The status line: the last painted row, where the byline sits below the composer. */
function lastRow(frame: string): string {
  const rows = frame.split('\n');
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]?.trim() ?? '';
    if (row !== '') return row;
  }
  return '';
}

function readIfPresent(path: string): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text === '') return '(empty)';
    return text.split('\n').slice(-40).join('\n');
  } catch {
    return '(absent)';
  }
}

it('shows a seat retry on the status line and leaves no row', { timeout: 300_000 }, async () => {
  const target = createStopContinueFixture();
  const trustHome = createTrustHome('seat-retry-status-line');
  const shims = join(target.tmpDir, 'bin');
  mkdirSync(shims);
  const invocationsPath = join(target.tmpDir, 'build-invocations');
  const argvPath = join(target.tmpDir, 'cmd-argv.jsonl');
  writeFakeNodeCli(shims, 'cmd', fakeCommandCodeScript(invocationsPath, argvPath));
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'command-code', contextLength: 200_000 },
  });
  try {
    mkdirSync(join(trustHome.home, '.commandcode'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(trustHome.home, '.commandcode', 'auth.json'),
      JSON.stringify({ apiKey: 'command-code-session-fixture' }),
      { mode: 0o600 },
    );
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trustHome.home, [shims]),
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
          'src/cli.ts',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--allow-unverified-auth',
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
        // The observation is armed before any listener, so the first frame that carries the
        // sentence is recorded even if it is repainted before the test body resumes.
        const observation = Promise.withResolvers<string | null>();
        let observed = false;
        let lastFrame = '';
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const finishObservation = (frame: string | null): void => {
          if (observed) return;
          observed = true;
          if (watchdog !== undefined) clearTimeout(watchdog);
          observation.resolve(frame);
        };
        const observeFrame = (frame: string): void => {
          lastFrame = frame;
          if (frame.includes(RETRY_SENTENCE)) finishObservation(frame);
        };
        watchdog = setTimeout(() => finishObservation(null), OBSERVATION_TIMEOUT_MS);
        watchdog.unref();
        const dataListener = child.onData((data) => {
          terminal.write(data, () => observeFrame(screen()));
        });
        const exitListener = child.onExit((event) => {
          outcome = event;
          finishObservation(null);
          exit.resolve(event);
        });
        /** The evidence a failed observation needs, read before cleanup removes it. */
        const describeFailure = async (reason: string): Promise<string> => {
          const lines = [
            reason,
            `child: ${outcome === undefined ? 'still running' : JSON.stringify(outcome)}`,
            `fake cmd argv (outside the project):\n${readIfPresent(argvPath)}`,
            `BUILD invocations: ${readIfPresent(invocationsPath)}`,
          ];
          let sessionId: string | undefined;
          try {
            sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
          } catch {
            sessionId = undefined;
          }
          if (sessionId === undefined) {
            lines.push('session events: no session');
          } else {
            try {
              const { events } = await readRunEvents({
                projectDir: target.projectDir,
                sessionId,
              });
              lines.push(
                `session ${sessionId} events (last 60):\n${events
                  .slice(-60)
                  .map((event) => JSON.stringify(event).slice(0, 400))
                  .join('\n')}`,
              );
            } catch (cause) {
              lines.push(`session events: unreadable (${String(cause)})`);
            }
          }
          lines.push(`last frame:\n${lastFrame}`);
          return lines.join('\n');
        };
        try {
          let retryFrame: string;
          try {
            const recorded = await observation.promise;
            if (recorded === null) {
              throw new Error('the retry sentence never reached the status line');
            }
            retryFrame = recorded;
          } catch (cause) {
            throw new Error(await describeFailure(String(cause)));
          }
          expect(lastRow(retryFrame)).toContain(RETRY_SENTENCE);
          expect(retryFrame.match(/Network or server failure/gu) ?? []).toHaveLength(1);
          await expect.poll(screen, { timeout: 120_000 }).toContain('Ready to apply');
          child.write('\x11');
          await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } finally {
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(events.filter((event) => event.type === 'seat_retry')).toMatchObject([
      { seat: 'build', attempt: 1, delayMs: 2_000 },
    ]);
    const transcript = transcriptText(events, VIEWPORT.cols);
    expect(transcript).not.toContain(RETRY_PHRASE);
    expect(readIfPresent(invocationsPath)).toBe('2');
    const markerPath = findMarker(target.isolationTreesDir);
    expect(markerPath).not.toBeNull();
    if (markerPath !== null) {
      expect(readFileSync(join(dirname(markerPath), 'greet.ts'), 'utf8')).toBe(GREET_SOURCE);
    }
  } finally {
    trustHome.restore();
    cleanupTempDir(target.tmpDir);
  }
});
