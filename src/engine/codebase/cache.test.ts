import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createParseCache } from './cache.js';
import { makeFileNode } from '#testing/helpers/factories/file-node.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('parseCache', () => {
  let dir: string;
  beforeEach(() => { dir = createTempDir('cache'); });
  afterEach(() => { cleanupTempDir(dir); });

  it('parses on miss and serves cache on subsequent identical mtime', async () => {
    const f = join(dir, 'a.ts'); writeFileSync(f, 'export function x() {}');
    const cache = createParseCache(join(dir, 'cache.sqlite'));
    let parseCount = 0;
    const parseSpy = (p: string) => { parseCount++; return Promise.resolve(makeFileNode(p)); };

    await cache.getOrParse(f, parseSpy);
    await cache.getOrParse(f, parseSpy);

    expect(parseCount).toBe(1);
    expect(cache.metrics.hits).toBe(1);
    expect(cache.metrics.misses).toBe(1);
  });

  it('re-parses when mtime changes', async () => {
    const f = join(dir, 'a.ts'); writeFileSync(f, 'export function x() {}');
    const cache = createParseCache(join(dir, 'cache.sqlite'));
    let parseCount = 0;
    const parseSpy = (p: string) => { parseCount++; return Promise.resolve(makeFileNode(p)); };

    await cache.getOrParse(f, parseSpy);
    // bump mtime by 5 seconds
    const newTime = new Date(Date.now() + 5000);
    utimesSync(f, newTime, newTime);
    await cache.getOrParse(f, parseSpy);

    expect(parseCount).toBe(2);
    expect(cache.metrics.misses).toBe(2);
  });

  it('re-parses when file size changes (mtime same)', async () => {
    const f = join(dir, 'a.ts'); writeFileSync(f, 'export function x() {}');
    const cache = createParseCache(join(dir, 'cache.sqlite'));
    let parseCount = 0;
    const parseSpy = (p: string) => { parseCount++; return Promise.resolve(makeFileNode(p)); };

    const stat = await import('node:fs').then(fs => fs.statSync(f));
    await cache.getOrParse(f, parseSpy);

    // Rewrite with different content but force same mtime
    writeFileSync(f, 'export function x(a: number) {}');
    utimesSync(f, stat.atime, stat.mtime);
    await cache.getOrParse(f, parseSpy);

    expect(parseCount).toBe(2); // size differs → cache miss
  });

  it('persists cache across instances (open the same db twice)', async () => {
    const f = join(dir, 'a.ts'); writeFileSync(f, 'export function x() {}');
    const dbPath = join(dir, 'cache.sqlite');
    let parseCount = 0;
    const parseSpy = (p: string) => { parseCount++; return Promise.resolve(makeFileNode(p)); };

    const cache1 = createParseCache(dbPath);
    await cache1.getOrParse(f, parseSpy);

    const cache2 = createParseCache(dbPath);
    await cache2.getOrParse(f, parseSpy);

    expect(parseCount).toBe(1); // second instance hit cache
    expect(cache2.metrics.hits).toBe(1);
  });
});
