import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runCommand } from '#testing/helpers/commander.js';
import { registerInitCommand } from '../../../src/cli/commands/init.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { configPath } from '../../../src/core/config/load/document.js';

function initHelp(): string {
  const program = new Command();
  registerInitCommand(program);
  const init = program.commands.find((command) => command.name() === 'init');
  if (init === undefined) throw new Error('init command not registered');
  return init.helpInformation();
}

let tmp: string;
let prevCwd: string;
let prevIsTTY: boolean | undefined;
let shimDir: string;
let restoreShim: () => void;

// `init --yes` saves only a crew detection finds ready, so every test brings its own ready Codex.
beforeEach(() => {
  shimDir = createTempDir('cli-init-non-tty-codex');
  restoreShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'codex',
      authChannel: 'session',
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Offline fixture');
    }),
  );
  tmp = createTempDir('cli-init-non-tty');
  prevCwd = process.cwd();
  process.chdir(tmp);
  prevIsTTY = process.stdin.isTTY;
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreShim();
  cleanupTempDir(shimDir);
  process.chdir(prevCwd);
  cleanupTempDir(tmp);
  (process.stdin as { isTTY?: boolean | undefined }).isTTY = prevIsTTY;
});

describe('CLI integration: init without a TTY', { timeout: 90_000 }, () => {
  it('defers the config write: init without a TTY fails fast and writes nothing', async () => {
    const { exitCode, stderr } = await runCommand(['init']);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/interactive mode needs a TTY/);
    expect(existsSync(configPath(tmp))).toBe(false);
  });

  // A CI user sees only this message, so every flag it names must exist.
  it('offers only flags that init actually defines', async () => {
    const { stderr } = await runCommand(['init']);
    const help = initHelp();

    const offered = [...stderr.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]);
    expect(offered.length).toBeGreaterThan(0);
    for (const flag of offered) {
      expect(help, `init --help does not document ${flag}`).toContain(flag);
    }
  });

  it('writes a loadable default config with --yes and no TTY', async () => {
    const { exitCode, stderr } = await runCommand(['init', '--yes']);

    expect(exitCode).toBe(0);
    expect(stderr).toBe(
      'No config found. Saved a ready crew to .splitbrief/config.yaml.\nAdded .splitbrief/ to .gitignore.\n',
    );
    expect(loadConfig(tmp).config.version).toBe(3);
  });

  it('writes into --project instead of the working directory', async () => {
    const target = createTempDir('cli-init-project');

    try {
      const { exitCode } = await runCommand(['init', '--yes', '--project', target]);

      expect(exitCode).toBe(0);
      expect(loadConfig(target).config.version).toBe(3);
      expect(existsSync(configPath(tmp))).toBe(false);
    } finally {
      cleanupTempDir(target);
    }
  });

  it('leaves an existing config alone unless --reconfigure is passed', async () => {
    await runCommand(['init', '--yes']);
    const original = readFileSync(configPath(tmp), 'utf8');

    const kept = await runCommand(['init', '--yes']);
    expect(kept.stdout).toContain('Use --reconfigure to overwrite.');
    expect(readFileSync(configPath(tmp), 'utf8')).toBe(original);

    const rewritten = await runCommand(['init', '--yes', '--reconfigure']);
    expect(rewritten.exitCode).toBe(0);
    expect(loadConfig(tmp).config.version).toBe(3);
  });
});
