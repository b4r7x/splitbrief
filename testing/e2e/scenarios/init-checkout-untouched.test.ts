import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 140;
const ROWS = 40;
const IGNORE_NOTICE = 'Added .splitbrief/ to .gitignore';
let tmpDir: string;
let projectDir: string;
let environment: Readonly<Record<string, string>>;
let offlinePath: string;

beforeEach(() => {
  tmpDir = createTempDir('init-checkout-untouched');
  projectDir = join(tmpDir, 'project');
  mkdirSync(projectDir);
  createTestGitRepo(projectDir, { '.gitignore': 'node_modules/\n' });
  const home = join(tmpDir, 'home');
  const bin = join(tmpDir, 'bin');
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
  environment = safeChildEnvironment(home, [bin]);
  offlinePath = join(tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in init E2E'); };\n",
  );
});

afterEach(() => cleanupTempDir(tmpDir));

function checkoutStatus(): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectDir,
    encoding: 'utf8',
  });
}

async function runInit(
  drive: (screen: () => string, write: (keys: string) => void) => Promise<void>,
) {
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: [
        '--import',
        'tsx',
        '--import',
        offlinePath,
        'src/cli.ts',
        'init',
        '--project',
        projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: REPO_ROOT,
        // A source run writes a development debug log under .splitbrief/; the built app does not.
        env: { ...environment, XDG_STATE_HOME: join(tmpDir, 'state'), SPLITBRIEF_DEBUG: '0' },
      },
    },
    async (child) => {
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
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
      const dataListener = child.onData((data) => terminal.write(data));
      try {
        await vi.waitFor(() => expect(screen()).toContain('PLAN      Claude Code CLI'), {
          timeout: 30_000,
        });
        await drive(screen, (keys) => child.write(keys));
        child.write('\u001b');
        await vi.waitFor(() => expect(didExit, screen()).toBe(true), { timeout: 10_000 });
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
  expect(result).toBeUndefined();
}

describe('e2e: init leaves the checkout untouched until the first save', () => {
  it('quits Setup without a save and leaves git status empty', async () => {
    await runInit(async () => {
      // Discovery finished; give a queued cache write the time it would take to land.
      await new Promise((settle) => setTimeout(settle, 1_000));
    });

    expect(checkoutStatus()).toBe('');
    expect(existsSync(join(projectDir, SPLITBRIEF_DIR))).toBe(false);
  });

  it('adds the ignore rule with the first seat save, says so once, and changes only .gitignore', async () => {
    await runInit(async (screen, write) => {
      write('\r');
      await vi.waitFor(() => expect(screen()).toContain('PLAN · tool, model, effort'), {
        timeout: 10_000,
      });
      write('\r');
      await vi.waitFor(() => expect(screen()).toContain(IGNORE_NOTICE), { timeout: 10_000 });
      expect(screen()).toContain('Saved PLAN · Claude Code CLI');
      expect(screen().split(IGNORE_NOTICE)).toHaveLength(2);
    });

    expect(checkoutStatus()).toBe(' M .gitignore\n');
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.splitbrief/\n',
    );
  });
});
