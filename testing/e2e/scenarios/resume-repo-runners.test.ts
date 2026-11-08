import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, type TestContext, vi } from 'vitest';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import type { Config } from '../../../src/core/schemas/config.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  endImplementerHold,
  findMarker,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 160, rows: 40 };
const TRUST_POLICY_REFUSAL = 'outside the current trust policy';
const AT_REST_LEGEND = 'esc home · shift+↑↓ scroll · ctrl+k commands · /sessions · /help';
let fixture: StopContinueFixture;
let environment: Readonly<Record<string, string>>;
let offlinePath: string;

beforeEach(async () => {
  fixture = createStopContinueFixture();
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
  };
  writeConfig(fixture.projectDir, config);
  await trustDeclaredRunners({
    projectDir: fixture.projectDir,
    config,
    pathEnv: environment.PATH ?? '',
    stateDir: join(home, SPLITBRIEF_DIR, 'trust'),
  });
  offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in resume E2E'); };\n",
  );
});

afterEach(async () => {
  await endImplementerHold(fixture);
  cleanupTempDir(fixture.tmpDir);
});

type Continue = (child: PtyProcess, screen: () => string) => Promise<void>;

const continueFromStopMenu: Continue = async (child) => {
  child.write('\r');
};

const continueWithEnter: Continue = async (child, screen) => {
  child.write('\t');
  await vi.waitFor(() => expect(screen()).not.toContain('Back to sessions'), { timeout: 10_000 });
  child.write('\r');
};

async function openSessionToContinue(child: PtyProcess, screen: () => string): Promise<void> {
  child.write('\x1b');
  await vi.waitFor(() => expect(screen()).toContain('Recent sessions'), { timeout: 10_000 });
  child.write('/sessions');
  await vi.waitFor(() => expect(screen()).toContain('Browse past sessions'), { timeout: 10_000 });
  child.write('\r');
  await vi.waitFor(() => expect(screen()).toContain('Sessions · 1'), { timeout: 10_000 });
  child.write('\r');
  await vi.waitFor(() => expect(screen()).toContain('⏎ to continue'), { timeout: 10_000 });
}

const continueFromSessions: Continue = async (child, screen) => {
  await openSessionToContinue(child, screen);
  child.write('\r');
};

/**
 * Starts the run in a PTY and stops it at the implementer's marker, up to the stop menu with
 * `Back to sessions`. Then runs `body` and quits with ctrl+c twice.
 */
async function withStoppedRun(
  context: TestContext,
  body: (child: PtyProcess, screen: () => string, output: () => string) => Promise<void>,
): Promise<void> {
  const result = await runWithPtyChild(
    {
      requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
      argv: [
        '--import',
        'tsx',
        '--import',
        offlinePath,
        'src/cli.ts',
        'start',
        'smoke',
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...VIEWPORT,
        cwd: REPO_ROOT,
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
      },
    },
    async (child) => {
      const terminal = new XtermHeadless.Terminal({
        ...VIEWPORT,
        allowProposedApi: true,
        logLevel: 'off',
      });
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
      let output = '';
      const screen = () =>
        Array.from(
          { length: VIEWPORT.rows },
          (_, row) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.viewportY + row)
              ?.translateToString(true) ?? '',
        ).join('\n');
      const dataListener = child.onData((data) => {
        output += data;
        terminal.write(data);
      });
      const exitListener = child.onExit((event) => {
        didExit = true;
        exited.resolve(event);
      });
      try {
        await vi.waitFor(
          () => expect(findMarker(fixture.isolationTreesDir), screen()).not.toBeNull(),
          { timeout: 75_000, interval: 100 },
        );
        child.write('\x1b');
        await vi.waitFor(() => expect(screen()).toContain('Stop options'), { timeout: 10_000 });
        child.write('\x1b');
        await vi.waitFor(() => expect(screen()).toContain('Resume'), { timeout: 15_000 });
        await vi.waitFor(() => expect(screen()).toContain('Back to sessions'), {
          timeout: 15_000,
        });

        await body(child, screen, () => output);

        child.write('\x03');
        await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
        child.write('\x03');
        await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 10_000 });
        expect(await exited.promise).toMatchObject({ exitCode: 0 });
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
  if (result) context.skip(result.reason);
}

it.for<[string, Continue]>([
  ['Resume in the stop menu', continueFromStopMenu],
  ['⏎ in the composer', continueWithEnter],
  ['/sessions', continueFromSessions],
])(
  'continues a run started with --allow-repo-runners after a stop, through %s',
  { timeout: 240_000 },
  async ([, continueRun], context) => {
    await withStoppedRun(context, async (child, screen, output) => {
      await continueRun(child, screen);
      const projectDir = await canonicalizeProjectDir({ project: fixture.projectDir });
      const sessionId = readActive(projectDir);
      if (sessionId === null)
        throw new Error(`the stopped run left no active session\n${screen()}`);
      await vi.waitFor(
        () => {
          expect(output()).not.toContain(TRUST_POLICY_REFUSAL);
          expect(readState(fixture, sessionId).tasks[0]?.status, screen()).toBe('done');
        },
        { timeout: 60_000, interval: 100 },
      );
      expect(readFileSync(join(fixture.tmpDir, 'implementer-invocations'), 'utf8')).toBe('2');
      expect(output()).not.toContain(TRUST_POLICY_REFUSAL);
    });
  },
);

it('drops ctrl+k commands from the legend while the tools check to continue the run', {
  timeout: 240_000,
}, async (context) => {
  const home = join(fixture.tmpDir, 'home');
  const bin = join(fixture.tmpDir, 'bin');
  const armed = join(fixture.tmpDir, 'hang-armed');
  const pidFile = join(fixture.tmpDir, 'sign-in.pid');
  const opencodeData = join(home, '.local', 'share', 'opencode');
  mkdirSync(opencodeData, { recursive: true });
  writeFileSync(join(opencodeData, 'auth.json'), '{"anthropic":{"type":"api"}}');
  writeFakeNodeCli(
    bin,
    'opencode',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  if (fs.existsSync(${JSON.stringify(armed)})) {
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1_000_000);
  } else {
    console.log(${JSON.stringify(JSON.stringify([{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'credential' }] }]))});
    process.exit(0);
  }
} else {
  process.exit(1);
}`,
  );
  const config: Config = {
    ...loadConfig(fixture.projectDir).config,
    reviewer: { kind: 'cli', tool: 'opencode', model: 'anthropic/claude-sonnet-5' },
  };
  writeConfig(fixture.projectDir, config);
  await trustDeclaredRunners({
    projectDir: fixture.projectDir,
    config,
    pathEnv: environment.PATH ?? '',
    stateDir: join(home, SPLITBRIEF_DIR, 'trust'),
  });

  await withStoppedRun(context, async (child, screen) => {
    const legendRow = () =>
      screen()
        .split('\n')
        .find((row) => row.includes('/sessions · /help')) ?? '';
    let signInPid: number | undefined;
    try {
      await openSessionToContinue(child, screen);
      await vi.waitFor(() => expect(legendRow(), screen()).toContain(AT_REST_LEGEND), {
        timeout: 10_000,
      });

      writeFileSync(armed, '');
      child.write('\r');
      await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true);
      signInPid = Number(readFileSync(pidFile, 'utf8'));
      await vi.waitFor(() => expect(screen()).toContain('Checking tools'), { timeout: 15_000 });
      await vi.waitFor(
        () => {
          expect(legendRow(), screen()).toContain('shift+↑↓ scroll · /sessions · /help');
          expect(legendRow()).not.toContain('esc home');
        },
        { timeout: 10_000 },
      );
      expect(legendRow()).not.toContain('ctrl+k commands');

      child.write('\x1b');
      await vi.waitFor(() => expect(screen()).not.toContain('Checking tools'), {
        timeout: 20_000,
      });
      await vi.waitFor(() => expect(legendRow(), screen()).toContain(AT_REST_LEGEND), {
        timeout: 10_000,
      });
    } finally {
      if (signInPid !== undefined) {
        try {
          process.kill(signInPid, 'SIGKILL');
        } catch {}
      }
    }
  });
});
