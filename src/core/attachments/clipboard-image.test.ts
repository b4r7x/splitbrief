import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readClipboardImage } from './clipboard-image.js';

const clipboard = vi.hoisted(() => ({ home: '', output: '', delay: 0 }));

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => clipboard.home,
}));

vi.mock('node:child_process', async (original) => {
  const native = await original<typeof import('node:child_process')>();
  return {
    ...native,
    execFile: (
      _file: string,
      _args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) =>
      native.execFile(
        process.execPath,
        [
          '-e',
          'process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.stdout.write(process.env.PASTE_FIXTURE_OUTPUT), Number(process.env.PASTE_FIXTURE_DELAY)))',
        ],
        {
          ...options,
          env: {
            ...process.env,
            PASTE_FIXTURE_OUTPUT: clipboard.output,
            PASTE_FIXTURE_DELAY: String(clipboard.delay),
          },
        },
        callback,
      ),
  };
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=',
  'base64',
);
const originalPlatform = process.platform;

beforeEach(() => {
  clipboard.home = createTempDir('clipboard-image');
  clipboard.output = PNG.toString('base64');
  clipboard.delay = 0;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  cleanupTempDir(clipboard.home);
});

describe('clipboard image storage', () => {
  it('keeps a private PNG available for history and reuses identical clipboard content', async () => {
    const first = await readClipboardImage({ signal: new AbortController().signal });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(await readFile(first.path)).toEqual(PNG);
    expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(clipboard.home, '.splitbrief', 'clipboard'))).mode & 0o777).toBe(
      0o700,
    );

    const second = await readClipboardImage({ signal: new AbortController().signal });
    expect(second).toEqual(first);
    expect(await readdir(join(clipboard.home, '.splitbrief', 'clipboard'))).toHaveLength(1);
  });

  it.each([
    ['no-image', 'no-image'],
    ['too-large', 'too-large'],
    ['not an encoded PNG', 'unavailable'],
  ])('reports %s without creating an image file', async (output, reason) => {
    clipboard.output = output;
    expect(await readClipboardImage({ signal: new AbortController().signal })).toEqual({
      ok: false,
      reason,
    });
    expect(await readdir(clipboard.home)).toEqual([]);
  });

  it('cancels a pending OS read and limits a hung reader', async () => {
    clipboard.delay = 10_000;
    const controller = new AbortController();
    const pending = readClipboardImage({ signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
    expect(await readdir(clipboard.home)).toEqual([]);

    expect(await readClipboardImage({ signal: new AbortController().signal })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await readdir(clipboard.home)).toEqual([]);
  });

  it('reports unsupported platforms without creating files', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(await readClipboardImage({ signal: new AbortController().signal })).toEqual({
      ok: false,
      reason: 'unsupported-platform',
    });
    expect(await readdir(clipboard.home)).toEqual([]);
  });
});
