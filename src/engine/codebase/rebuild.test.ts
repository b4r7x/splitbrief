import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildRepomap } from './rebuild.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('rebuildRepomap', () => {
  let projectDir: string;
  beforeEach(() => { projectDir = createTempDir('repomap-rebuild'); });
  afterEach(() => { cleanupTempDir(projectDir); });

  it('returns deleted=false when no cache file exists', () => {
    const result = rebuildRepomap(projectDir);
    expect(result.deleted).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('deletes the sqlite + sidecar files when present', () => {
    const dir = join(projectDir, '.diptych');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'repomap.sqlite'), 'data');
    writeFileSync(join(dir, 'repomap.sqlite-shm'), 'shm');
    writeFileSync(join(dir, 'repomap.sqlite-wal'), 'wal');

    const result = rebuildRepomap(projectDir);
    expect(result.deleted).toBe(true);
    expect(result.files.length).toBe(3);
    expect(existsSync(join(dir, 'repomap.sqlite'))).toBe(false);
  });

  it('is idempotent — second call when file is gone returns deleted=false', () => {
    const dir = join(projectDir, '.diptych');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'repomap.sqlite'), 'data');

    rebuildRepomap(projectDir);
    const second = rebuildRepomap(projectDir);
    expect(second.deleted).toBe(false);
  });

  it('deletes cache files from a custom cacheDir', () => {
    const dir = join(projectDir, '.custom-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'repomap.sqlite'), 'data');

    const result = rebuildRepomap(projectDir, { cacheDir: '.custom-cache' });

    expect(result.deleted).toBe(true);
    expect(result.files).toEqual([join(dir, 'repomap.sqlite')]);
    expect(existsSync(join(dir, 'repomap.sqlite'))).toBe(false);
  });
});
