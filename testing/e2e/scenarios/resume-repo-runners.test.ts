import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
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

const continueFromSessions: Continue = async (child, screen) => {
  child.write('\x1b');
  await vi.waitFor(() => expect(screen()).toContain('Recent sessions'), { timeout: 10_000 });
  child.write('/sessions');
  await vi.waitFor(() => expect(screen()).toContain('Browse past sessions'), { timeout: 10_000 });
  child.write('\r');
  await vi.waitFor(() => expect(screen()).toContain('Sessions · 1'), { timeout: 10_000 });
  child.write('\r');
  await vi.waitFor(() => expect(screen()).toContain('⏎ to continue'), { timeout: 10_000 });
  child.write('\r');
};

it.for<[string, Continue]>([
  ['Resume in the stop menu', continueFromStopMenu],
  ['⏎ in the composer', continueWithEnter],
  ['/sessions', continueFromSessions],
])(
  'continues a run started with --allow-repo-runners after a stop, through %s',
  { timeout: 240_000 },
  async ([, continueRun], context) => {
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

          await continueRun(child, screen);
          const projectDir = await canonicalizeProjectDir({ project: fixture.projectDir });
          const sessionId = readActive(projectDir);
          if (sessionId === null)
            throw new Error(`the stopped run left no active session\n${screen()}`);
          await vi.waitFor(
            () => {
              expect(output).not.toContain(TRUST_POLICY_REFUSAL);
              expect(readState(fixture, sessionId).tasks[0]?.status, screen()).toBe('done');
            },
            { timeout: 60_000, interval: 100 },
          );
          expect(readFileSync(join(fixture.tmpDir, 'implementer-invocations'), 'utf8')).toBe('2');
          expect(output).not.toContain(TRUST_POLICY_REFUSAL);

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
  },
);
