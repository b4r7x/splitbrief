import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
