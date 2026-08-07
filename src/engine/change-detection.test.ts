import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChangeDetector, captureChangeDetectorBaseline } from './change-detection.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

describe('file-hash change detection', () => {
  it('ignores files matched by the original project gitignore when staged copy has no git metadata', async () => {
    const projectDir = createTempDir('change-detect-ignore-project');
    const stagedDir = createTempDir('change-detect-ignore-staged');
    try {
      createTestGitRepo(projectDir);
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n*.log\n');
      writeFileSync(join(stagedDir, '.gitignore'), 'dist/\n*.log\n');
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'export const app = true;\n');
      expect(existsSync(join(stagedDir, '.git'))).toBe(false);

      const baseline = await captureChangeDetectorBaseline(stagedDir, {
        ignoreProjectDir: projectDir,
      });
      const detect = createChangeDetector('Direct implementer');

      mkdirSync(join(stagedDir, 'dist'), { recursive: true });
      writeFileSync(join(stagedDir, 'dist', 'bundle.js'), 'ignored output\n');
      writeFileSync(join(stagedDir, 'debug.log'), 'ignored log\n');
      expect(await detect(stagedDir, baseline)).toEqual({
        changed: false,
        output: 'Direct implementer exited without changing any files',
        reason: 'no-files-changed',
      });

      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'export const app = false;\n');
      expect(await detect(stagedDir, baseline)).toEqual({ changed: true, output: '' });
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('reports a change when a new non-ignored file appears against the baseline', async () => {
    const stagedDir = createTempDir('change-detect-new-file');
    try {
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'export const app = true;\n');
      expect(existsSync(join(stagedDir, '.git'))).toBe(false);

      const baseline = await captureChangeDetectorBaseline(stagedDir);
      expect(baseline.kind).toBe('file-hashes');
      const detect = createChangeDetector('Direct implementer');

      writeFileSync(join(stagedDir, 'src', 'added.ts'), 'export const added = true;\n');
      const changed = await detect(stagedDir, baseline);
      expect(changed).toEqual({ changed: true, output: '' });
      expect('reason' in changed).toBe(false);
    } finally {
      cleanupTempDir(stagedDir);
    }
  });

  it('reports a change when a baseline-tracked file is deleted', async () => {
    const stagedDir = createTempDir('change-detect-deleted-file');
    try {
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'export const app = true;\n');
      expect(existsSync(join(stagedDir, '.git'))).toBe(false);

      const baseline = await captureChangeDetectorBaseline(stagedDir);
      expect(baseline.kind).toBe('file-hashes');
      const detect = createChangeDetector('Direct implementer');

      rmSync(join(stagedDir, 'src', 'app.ts'));
      expect(await detect(stagedDir, baseline)).toEqual({ changed: true, output: '' });
    } finally {
      cleanupTempDir(stagedDir);
    }
  });

  it('detects a rewrite of a file the workspace was already dirty in when the caller declares the kind', async () => {
    const repoDir = createTempDir('change-detect-already-dirty');
    try {
      createTestGitRepo(repoDir, { 'src/app.ts': 'export const app = true;\n' });
      writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const app = 1;\n');
      expect(existsSync(join(repoDir, '.git'))).toBe(true);

      const inferred = await captureChangeDetectorBaseline(repoDir);
      expect(inferred).toEqual({ kind: 'git-status', files: ['src/app.ts'] });
      const declared = await captureChangeDetectorBaseline(repoDir, { kind: 'file-hashes' });
      expect(declared.kind).toBe('file-hashes');
      const detect = createChangeDetector('Direct implementer');

      writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const app = 2;\n');

      expect(await detect(repoDir, declared)).toEqual({ changed: true, output: '' });
      // The comparator the directory would have selected on its own compares path
      // membership, and this path was already in the baseline: this is the blind
      // spot the declared kind exists to route around.
      expect(await detect(repoDir, inferred)).toEqual({
        changed: false,
        output: 'Direct implementer exited without changing any files',
        reason: 'no-files-changed',
      });
    } finally {
      cleanupTempDir(repoDir);
    }
  });

  it('uses the file-hash baseline for a staged dir nested inside a parent git repo', async () => {
    const repoDir = createTempDir('change-detect-parent-repo');
    try {
      createTestGitRepo(repoDir);
      // Staged copy lives inside the parent repo but carries no .git of its own,
      // mirroring a staging dir created under a TMPDIR that sits in a git repo.
      const stagedDir = join(repoDir, 'staged');
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'export const app = true;\n');
      expect(existsSync(join(stagedDir, '.git'))).toBe(false);

      const baseline = await captureChangeDetectorBaseline(stagedDir);
      expect(baseline.kind).toBe('file-hashes');

      const detect = createChangeDetector('Direct implementer');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'export const app = false;\n');
      expect(await detect(stagedDir, baseline)).toEqual({ changed: true, output: '' });
    } finally {
      cleanupTempDir(repoDir);
    }
  });
});
