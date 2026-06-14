import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { resolveChangedFiles } from './sections-io.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function makeProject(): string {
  const projectDir = createTempDir('sections-io-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

function driftWith(changedFiles: string[]): DriftReport {
  return {
    version: 1,
    passed: true,
    score: 1,
    changedFiles,
    expectedFiles: [],
    findings: [],
    briefHash: null,
  };
}

describe('resolveChangedFiles', () => {
  it('uses the drift report changed files (deduped, sorted) without consulting git or reporting missing', async () => {
    const projectDir = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles(
      projectDir,
      driftWith(['src/b.ts', 'src/a.ts', 'src/a.ts']),
      missing,
    );

    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(missing).toEqual([]);
  });

  it('reports "changed files" missing instead of an empty-but-confident list when no drift report and the tree is clean', async () => {
    const projectDir = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles(projectDir, null, missing);

    expect(files).toEqual([]);
    expect(missing).toContain('changed files');
  });

  it('surfaces files committed since run-start when per-task commits leave a clean working tree', async () => {
    const projectDir = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    // A per-task commit (prefixed `feat(diptych):`) moves the run's change out of
    // the working tree, leaving `git status` empty.
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    git('add src/feature.ts');
    git('commit -m "feat(diptych): T1 - add feature"');

    const missing: string[] = [];
    const files = await resolveChangedFiles(projectDir, null, missing);

    expect(files).toEqual(['src/feature.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('routes the no-drift fallback through the run-baseline filter, dropping diptych-internal paths', async () => {
    const projectDir = makeProject();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    // An internal control-plane write that must NOT surface as a changed file.
    mkdirSync(join(projectDir, '.diptych', 'sessions'), { recursive: true });
    writeFileSync(join(projectDir, '.diptych', 'sessions', 'state.json'), '{}\n');

    const missing: string[] = [];
    const files = await resolveChangedFiles(projectDir, null, missing);

    expect(files).toContain('src/feature.ts');
    expect(files.some((f) => f.startsWith('.diptych'))).toBe(false);
    expect(missing).not.toContain('changed files');
  });
});
