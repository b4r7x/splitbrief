import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { getSplitbriefVersion } from './core/paths-io.js';

const ROOT = join(import.meta.dirname, '..');
const CLI_ENTRY = join(ROOT, 'src', 'cli.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

describe('SPLITBRIEF CLI identity', () => {
  it('prints the canonical version', () => {
    const result = spawnSync(TSX, [CLI_ENTRY, '--version'], {
      cwd: ROOT,
      timeout: 60_000,
      encoding: 'utf-8',
    });

    expect(result.stdout.trim()).toBe(getSplitbriefVersion());
    expect(result.status).toBe(0);
  }, 60_000);

  it('uses the canonical executable and display identity in help', () => {
    const result = spawnSync(TSX, [CLI_ENTRY, '--help'], {
      cwd: ROOT,
      timeout: 60_000,
      encoding: 'utf-8',
    });

    expect(result.stdout).toContain('Usage: splitbrief');
    expect(result.stdout).toContain('SPLITBRIEF');
    expect(result.status).toBe(0);
  }, 60_000);
});
