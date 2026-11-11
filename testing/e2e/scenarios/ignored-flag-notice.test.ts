import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath } from '../../../src/core/config/load/document.js';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 140;
const ROWS = 40;
const IGNORED = "--implementer-api-base is ignored: the implementer 'cli' runner does not use it.";
const IGNORED_HEAD = '--implementer-api-base is ignored';
const FLAGS = ['--implementer-api-base', 'http://127.0.0.1:9/v1', '--implementer-model', 'm'];

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

function linesWith(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

function offlineFetch(dir: string): string {
  const path = join(dir, 'offline.mjs');
  writeFileSync(
    path,
    "globalThis.fetch = async () => { throw new Error('Network disabled in ignored-flag E2E'); };\n",
  );
  return path;
}

describe('e2e: a flag the seat does not use is told once', () => {
  it('shows the notice with no count on an interactive first run and prints it once after quit', async () => {
    fixture = createStopContinueFixture(() => '');
    unlinkSync(configPath(fixture.projectDir));
    const home = join(fixture.tmpDir, 'home');
    const bin = join(fixture.tmpDir, 'bin');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
    }
    writeFakeNodeCli(
      bin,
      'claude',
      `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}');
else if (args.includes('--help')) console.log('Claude Code fixture');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true }));
else { console.error('Unexpected model call'); process.exitCode = 1; }
`,
    );
    const environment = safeChildEnvironment(home, [bin]);
    const offline = offlineFetch(fixture.tmpDir);
    const stderrPath = join(fixture.tmpDir, 'stderr');
    const wrapperPath = join(fixture.tmpDir, 'terminal-cli.mjs');
    writeFileSync(
      wrapperPath,
      `import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
const child = spawn(process.execPath, [
  '--import', 'tsx', '--import', ${JSON.stringify(offline)},
  'src/cli.ts', ...process.argv.slice(2),
], { stdio: ['inherit', 'inherit', openSync(${JSON.stringify(stderrPath)}, 'w')] });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
`,
    );

    const result = await runWithPtyChild(
      {
        requirement: 'required',
        argv: [wrapperPath, 'start', 'x', ...FLAGS, '--project', fixture.projectDir],
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
        const counted: string[] = [];
        let noticeShown = false;
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
          terminal.write(data, () => {
            const text = screen();
            counted.push(...linesWith(text, 'all shown when you quit'));
            if (text.includes(IGNORED_HEAD)) noticeShown = true;
          });
        });
        try {
          await vi.waitFor(() => expect(screen()).toContain('Set up your crew'), {
            timeout: 20_000,
          });
          expect(noticeShown, 'a frame showed the ignored-flag notice').toBe(true);
          expect.soft(counted).toEqual([]);
          child.write('\x03');
          await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
          child.write('\x03');
          await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 5000 });
          expect(await exited.promise).toMatchObject({ exitCode: 0 });
          expect(linesWith(readFileSync(stderrPath, 'utf8'), 'is ignored')).toEqual([IGNORED]);
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
  });

  it('prints the notice once on a headless first run', async () => {
    fixture = createStopContinueFixture(() => '');
    unlinkSync(configPath(fixture.projectDir));
    mkdirSync(join(fixture.tmpDir, 'bin'));
    const restorePath = activateSafeCliShimPath(join(fixture.tmpDir, 'bin'));
    try {
      vi.stubEnv('NODE_OPTIONS', `--import=${offlineFetch(fixture.tmpDir)}`);
      vi.stubEnv('HOME', join(fixture.tmpDir, 'home'));

      const run = await cli(fixture, ['start', ...FLAGS, 'Add a greeting helper']);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('No config found and no ready crew is available.');
      expect(linesWith(run.stderr, 'is ignored')).toEqual([IGNORED]);
    } finally {
      restorePath();
    }
  });

  it('prints the notice once on a headless start whose config holds a CLI implementer', async () => {
    fixture = createStopContinueFixture(() => '');
    writeConfig(
      fixture.projectDir,
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
      }),
    );
    mkdirSync(join(fixture.tmpDir, 'bin'));
    const restorePath = activateSafeCliShimPath(join(fixture.tmpDir, 'bin'));
    try {
      vi.stubEnv('NODE_OPTIONS', `--import=${offlineFetch(fixture.tmpDir)}`);
      vi.stubEnv('HOME', join(fixture.tmpDir, 'home'));

      const run = await cli(fixture, ['start', ...FLAGS, 'Add a greeting helper']);

      expect(run.exitCode).toBe(1);
      expect(linesWith(run.stderr, 'is ignored')).toEqual([IGNORED]);
    } finally {
      restorePath();
    }
  });
});
