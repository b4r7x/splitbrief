import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Normalize macOS's /private aliases when comparing temporary paths. */
export function normalizeMacTmpPath(path: string | null): string | null {
  return path?.replace(/^\/private(\/(?:tmp|var)\/)/, '$1') ?? null;
}

export function cleanupTempDir(dir: string): void {
  // maxRetries re-walks the tree when a straggler process (e.g. a fixture's fake command still
  // draining stdin) recreates an entry mid-delete and rmdir reports ENOTEMPTY.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
