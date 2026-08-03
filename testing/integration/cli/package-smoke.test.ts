import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const SKIP_TOP_LEVEL = new Set([
  'node_modules',
  'dist',
  '.git',
  '.trees',
  '.splitbrief',
  '.splitbrief',
]);

function copyProjectForSmoke(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = relative(src, source);
      if (!rel) return true;
      const top = rel.split(/[/\\]/)[0];
      return !(top && SKIP_TOP_LEVEL.has(top));
    },
  });
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

let workDir: string;
let installDir: string;
let installedPkgDir: string;
let binPath: string;
let pkgVersion: string;

beforeAll(() => {
  pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

  workDir = mkdtempSync(join(tmpdir(), 'splitbrief-smoke-src-'));
  copyProjectForSmoke(ROOT, workDir);

  execFileSync('npm', ['ci'], {
    cwd: workDir,
    stdio: 'pipe',
    env: { ...process.env, npm_config_cache: join(workDir, '.npm-cache') },
  });
  execFileSync('npm', ['run', 'build'], { cwd: workDir, stdio: 'pipe' });

  const packParent = mkdtempSync(join(tmpdir(), 'splitbrief smoke pack '));
  const packDir = join(packParent, 'pack');
  mkdirSync(packDir, { recursive: true });

  execFileSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: workDir,
    stdio: 'pipe',
  });

  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');

  const installParent = mkdtempSync(join(tmpdir(), 'splitbrief smoke install '));
  installDir = join(installParent, 'install');
  mkdirSync(installDir, { recursive: true });

  execFileSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(packDir, tgz)],
    { cwd: installDir, stdio: 'pipe' },
  );

  installedPkgDir = join(installDir, 'node_modules', 'splitbrief');
  binPath = join(installDir, 'node_modules', '.bin', 'splitbrief');
}, 300_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (installDir) {
    const parent = join(installDir, '..');
    rmSync(parent, { recursive: true, force: true });
  }
}, 60_000);

describe('package smoke test', () => {
  it('--help exits 0 and prints usage', () => {
    const result = spawnSync(binPath, ['--help'], {
      cwd: installDir,
      timeout: 30_000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('splitbrief');

    const exampleLines = result.stdout
      .split('\n')
      .filter((line) => line.trim().startsWith('$ splitbrief'));
    expect(exampleLines.length).toBeGreaterThanOrEqual(10);
    for (const snippet of [
      '$ splitbrief "',
      '$ splitbrief start "',
      '@design.md',
      '@screenshot.png',
      '--mode instant',
      '--mode quick',
      '--mode speckit',
      '--worktree',
      '--detach',
      '--json',
      'splitbrief status',
      'splitbrief resume',
      'splitbrief doctor',
    ]) {
      expect(result.stdout).toContain(snippet);
    }
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

  it('ships no .d.ts declaration files in the published package', () => {
    const declarationFiles = listFilesRecursive(installedPkgDir)
      .filter((f) => f.endsWith('.d.ts'))
      .map((f) => relative(installedPkgDir, f));

    expect(declarationFiles).toEqual([]);
  });
});
