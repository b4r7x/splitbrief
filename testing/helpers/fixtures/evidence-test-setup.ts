import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach } from 'vitest';

export function setupEvidenceTmpDir(): { get(): string } {
  let tmpDir = '';
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
  return { get: () => tmpDir };
}
