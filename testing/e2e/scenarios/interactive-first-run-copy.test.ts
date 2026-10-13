import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 160;
const ROWS = 40;
const APPROVE = 'Approve plan and start the build';
let fixture: StopContinueFixture;
let environment: Readonly<Record<string, string>>;
let wrapperPath: string;
let stderrPath: string;

beforeEach(async () => {
  fixture = createStopContinueFixture(
    () => "throw new Error('BUILD must not start before plan approval');\n",
    { isolation: 'none' },
  );
  const home = join(fixture.tmpDir, 'home');
  const bin = join(fixture.tmpDir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  for (const tool of Object.values(CLI_TOOL_CATALOG)) {
    writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
  }
  environment = safeChildEnvironment(home, [bin]);
  const initial = loadConfig(fixture.projectDir).config;
  const config = {
    ...initial,
    planner: { ...initial.planner, command: process.execPath },
    implementer: { ...initial.implementer, command: process.execPath },
    workflow: { ...initial.workflow, approve: 'plan' as const },
  };
  writeConfig(fixture.projectDir, config);
  await trustDeclaredRunners({
    projectDir: fixture.projectDir,
    config,
    stateDir: join(home, SPLITBRIEF_DIR, 'trust'),
  });
  const offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in interactive copy E2E'); };\n",
  );
  stderrPath = join(fixture.tmpDir, 'stderr');
  wrapperPath = join(fixture.tmpDir, 'terminal-cli.mjs');
  writeFileSync(
    wrapperPath,
    `import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
const child = spawn(process.execPath, [
  '--import', 'tsx', '--import', ${JSON.stringify(offlinePath)},
  'src/cli.ts', ...process.argv.slice(2),
], { stdio: ['inherit', 'inherit', openSync(${JSON.stringify(stderrPath)}, 'w')] });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
`,
  );
});

afterEach(() => cleanupTempDir(fixture.tmpDir));

async function runInteractive(
  args: readonly string[],
  observe: (screen: () => string, firstCard: () => string | undefined) => Promise<void>,
): Promise<void> {
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: [wrapperPath, ...args, '--allow-repo-runners', '--project', fixture.projectDir],
      spawnOptions: {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: REPO_ROOT,
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
      },
    },
    async (child) => {
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
      let rawIo = '';
      let firstCard: string | undefined;
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
      const exitListener = child.onExit((event) => {
        didExit = true;
        exited.resolve(event);
      });
      const dataListener = child.onData((data) => {
        rawIo += data;
        terminal.write(data, () => {
          const frame = screen();
          if (firstCard === undefined && frame.includes(APPROVE)) firstCard = frame;
        });
      });
      try {
        await observe(screen, () => firstCard);
        expect(readFileSync(stderrPath, 'utf8')).toBe('');
        expect(rawIo).toContain(terminalSequences.enterAltBuffer);
        expect(rawIo).toContain(terminalSequences.hideCursor);
        child.write('\x03');
        await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
        child.write('\x03');
        await vi.waitFor(() => expect(didExit, rawIo).toBe(true), { timeout: 5000 });
        expect(await exited.promise).toMatchObject({ exitCode: 0 });
        expect(readFileSync(stderrPath, 'utf8')).toBe('');
        expect(rawIo.lastIndexOf(terminalSequences.exitAltBuffer)).toBeGreaterThan(
          rawIo.lastIndexOf(terminalSequences.enterAltBuffer),
        );
        expect(rawIo.lastIndexOf(terminalSequences.showCursor)).toBeGreaterThan(
          rawIo.lastIndexOf(terminalSequences.hideCursor),
        );
      } finally {
        try {
          if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
        } finally {
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      }
    },
  );
  expect(result).toBeUndefined();
}

describe('e2e: interactive first-run copy', () => {
  it('keeps stderr empty on interactive startup and process exit', async () => {
    await runInteractive(['start'], async (screen) => {
      await vi.waitFor(() => expect(screen()).toContain('Describe your feature'), {
        timeout: 20_000,
      });
      expect(existsSync(stderrPath)).toBe(true);
      expect(readFileSync(stderrPath, 'utf8')).toBe('');
    });
  });

  it('publishes tasks before the first plan approval card opens', async () => {
    await runInteractive(['start', 'smoke'], async (_screen, firstCard) => {
      await vi.waitFor(() => expect(firstCard()).toBeDefined(), { timeout: 30_000 });
      expect(firstCard()).toContain('Tasks');
      expect(firstCard()).toContain('Add a greeting helper');
      expect(firstCard()).not.toContain('Waiting for your answer');
      const sessionId = readActive(fixture.projectDir);
      if (sessionId === null) throw new Error('The plan card has no active session');
      const replay = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
      expect(replay.events.find((event) => event.type === 'tasks_planned')).toMatchObject({
        total: 1,
        tasks: [expect.objectContaining({ title: 'Add a greeting helper' })],
      });
      expect(replay.events.some((event) => event.type === 'task_started')).toBe(false);
      expect(existsSync(fixture.markerPath)).toBe(false);
    });
  });
});
