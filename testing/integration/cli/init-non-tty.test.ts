import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runCommand } from '#testing/helpers/commander.js';
import { configPath } from '../../../src/core/config/load/io.js';

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = createTempDir('cli-init-non-tty');
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('CLI integration: init without a TTY', { timeout: 90_000 }, () => {
  it('defers the config write: init without a TTY fails fast and writes nothing', async () => {
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    const { exitCode, stderr } = await runCommand(['init']);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/interactive mode needs a TTY/);
    expect(existsSync(configPath(tmp))).toBe(false);
  });
});
