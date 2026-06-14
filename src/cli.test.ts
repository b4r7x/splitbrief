import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { getDiptychVersion } from './core/paths-io.js';

const ROOT = join(import.meta.dirname, '..');
const CLI_ENTRY = join(ROOT, 'src', 'cli.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

describe('cli --version', () => {
  it('prints the version reported by getDiptychVersion', () => {
    const result = spawnSync(TSX, [CLI_ENTRY, '--version'], {
      cwd: ROOT,
      timeout: 60_000,
      encoding: 'utf-8',
    });

    expect(result.stdout.trim()).toBe(getDiptychVersion());
    expect(result.status).toBe(0);
  }, 60_000);
});
