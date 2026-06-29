import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coverageRunDirectory, pruneCoverageRuns } from './coverage-run.js';

describe('coverage-run', () => {
  let root: string;

  const makeRun = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'coverage-runs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds deterministic coverage run directory names from time and pid', () => {
    expect(coverageRunDirectory({ coverageDir: root, nowMs: 1234, pid: 99 })).toBe(
      join(root, 'run-1234-99'),
    );
  });

  it('prunes oldest run directories by numeric run name', () => {
    makeRun('run-100-1');
    makeRun('run-300-1');
    makeRun('run-200-1');
    makeRun('run-9');

    const result = pruneCoverageRuns({ coverageDir: root, keep: 2 });

    expect(result.removed.map((path) => basename(path))).toEqual(['run-100-1', 'run-9']);
    expect(existsSync(join(root, 'run-300-1'))).toBe(true);
    expect(existsSync(join(root, 'run-200-1'))).toBe(true);
    expect(existsSync(join(root, 'run-100-1'))).toBe(false);
    expect(existsSync(join(root, 'run-9'))).toBe(false);
  });

  it('keeps active and protected run directories while pruning complete old runs', () => {
    const protectedRun = makeRun('run-100-1');
    makeRun('run-200-1');
    makeRun('run-300-1');
    writeFileSync(join(root, '.run-300-1.active'), '300\n', 'utf-8');

    const result = pruneCoverageRuns({
      coverageDir: root,
      keep: 1,
      protectedRunDir: protectedRun,
    });

    expect(result.removed.map((path) => basename(path))).toEqual(['run-200-1']);
    expect(existsSync(protectedRun)).toBe(true);
    expect(existsSync(join(root, 'run-300-1'))).toBe(true);
    expect(existsSync(join(root, 'run-200-1'))).toBe(false);
  });
});
