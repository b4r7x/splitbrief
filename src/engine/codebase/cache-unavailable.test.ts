import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createParseCache } from './cache.js';
import { buildRepoMap } from './repomap.js';

const native = vi.hoisted(() => ({
  failure: new Error(
    'Could not locate the bindings file. Tried:\n/private/native/better_sqlite3.node',
  ),
}));
vi.mock('better-sqlite3', () => ({
  default: function Database() {
    throw native.failure;
  },
}));

describe('repo-map without the native cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('repomap-native-unavailable');
    writeFileSync(join(dir, 'entry.ts'), 'export function entry() { return "ok"; }');
  });
  afterEach(() => cleanupTempDir(dir));

  it.each([
    new Error('Could not locate the bindings file. Tried:\n/private/native/better_sqlite3.node'),
    Object.assign(new Error('Module ABI mismatch'), { code: 'ERR_DLOPEN_FAILED' }),
  ])(
    'builds useful context and separates the native diagnostic from its notice',
    async (failure) => {
      native.failure = failure;
      const warnings: { message: string; details: string | undefined }[] = [];
      const output = await buildRepoMap(dir, {
        onWarn: (message, details) => warnings.push({ message, details }),
      });

      expect(output).toContain('entry.ts:');
      expect(output).toContain('entry');
      expect(warnings).toEqual([
        {
          message: 'Repo-map cache unavailable. Continuing without caching.',
          details: failure.message,
        },
      ]);
      expect(existsSync(join(dir, '.splitbrief', 'repomap.sqlite'))).toBe(false);
    },
  );

  it('does not treat filesystem failures or an escaping cache path as a missing binding', async () => {
    native.failure = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    await expect(createParseCache(join(dir, 'cache.sqlite'))).rejects.toThrow('Permission denied');

    const cacheDir = join(dir, 'cache');
    const link = join(dir, 'cache-link');
    mkdirSync(cacheDir);
    symlinkSync(cacheDir, link);
    await expect(createParseCache(join(link, 'cache.sqlite'))).rejects.toMatchObject({
      kind: 'repomap-cache-escapes',
    });
    expect(existsSync(join(cacheDir, 'cache.sqlite'))).toBe(false);
  });
});
