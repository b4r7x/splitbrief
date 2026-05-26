import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..', '..', '..');

let installDir: string;
let binPath: string;
let pkgVersion: string;

beforeAll(() => {
  pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

  execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });

  installDir = mkdtempSync(join(tmpdir(), 'diptych-smoke-'));

  execSync('npm pack --pack-destination ' + installDir, { cwd: ROOT, stdio: 'pipe' });

  const tgz = readdirSync(installDir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');

  execSync(`npm install --no-audit --no-fund --ignore-scripts ${join(installDir, tgz)}`, {
    cwd: installDir,
    stdio: 'pipe',
  });

  binPath = join(installDir, 'node_modules', '.bin', 'diptych');
}, 180_000);

afterAll(() => {
  if (installDir) {
    rmSync(installDir, { recursive: true, force: true });
  }
});

describe('package smoke test', () => {
  it('--help exits 0 and prints usage', () => {
    const result = spawnSync(binPath, ['--help'], {
      cwd: installDir,
      timeout: 30_000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('diptych');
  }, 60_000);

  it('--version prints the package.json version', () => {
    const result = spawnSync(binPath, ['--version'], {
      cwd: installDir,
      timeout: 30_000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkgVersion);
  }, 60_000);

  it('doctor --json produces valid JSON output', () => {
    const result = spawnSync(binPath, ['doctor', '--json', '--project', installDir], {
      cwd: installDir,
      timeout: 30_000,
      encoding: 'utf-8',
    });

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.type).toBe('readiness_report');
    expect(parsed.report).toBeDefined();
  }, 60_000);
});
