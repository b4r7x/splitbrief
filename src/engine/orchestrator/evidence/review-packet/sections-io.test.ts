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

    const files = await resolveChangedFiles({
      projectDir,
      drift: driftWith(['src/b.ts', 'src/a.ts', 'src/a.ts']),
      missing,
    });

    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(missing).toEqual([]);
  });

  it('reports "changed files" missing instead of an empty-but-confident list when no drift report and the tree is clean', async () => {
    const projectDir = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles({ projectDir, drift: null, missing });

    expect(files).toEqual([]);
    expect(missing).toContain('changed files');
  });

  it('surfaces files committed since run-start when per-task commits leave a clean working tree', async () => {
    const projectDir = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    // A per-task commit (prefixed `feat(splitbrief):`) moves the run's change out of
    // the working tree, leaving `git status` empty.
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    git('add src/feature.ts');
    git('commit -m "feat(splitbrief): T1 - add feature"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({ projectDir, drift: null, missing });

    expect(files).toEqual(['src/feature.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('routes the no-drift fallback through the run-baseline filter, dropping splitbrief-internal paths', async () => {
    const projectDir = makeProject();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    // An internal control-plane write that must NOT surface as a changed file.
    mkdirSync(join(projectDir, '.splitbrief', 'sessions'), { recursive: true });
    writeFileSync(join(projectDir, '.splitbrief', 'sessions', 'state.json'), '{}\n');

    const missing: string[] = [];
    const files = await resolveChangedFiles({ projectDir, drift: null, missing });

    expect(files).toContain('src/feature.ts');
    expect(files.some((f) => f.startsWith('.splitbrief'))).toBe(false);
    expect(missing).not.toContain('changed files');
  });

  it('uses the persisted run boundary for no-drift review packets', async () => {
    const projectDir = makeProject();
    const git = (args: string) =>
      execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe', encoding: 'utf8' }).trim();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/pre-run.ts'), 'export const preRun = true;\n');
    git('add src/pre-run.ts');
    git('commit -m "feat(splitbrief): misleading pre-run subject"');
    const runStartHead = git('rev-parse HEAD');

    writeFileSync(join(projectDir, 'src/post-run.ts'), 'export const postRun = true;\n');
    git('add src/post-run.ts');
    git('commit -m "chore: arbitrary post-run subject"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/post-run.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('includes commits from an explicitly captured unborn boundary', async () => {
    const projectDir = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/from-unborn.ts'), 'export const value = true;\n');
    git('add src/from-unborn.ts');
    git('commit -m "chore: arbitrary subject"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      projectDir,
      drift: null,
      missing,
      baseline: { head: null },
    });

    expect(files).toContain('src/from-unborn.ts');
    expect(missing).not.toContain('changed files');
  });
});
