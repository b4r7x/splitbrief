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
      expect(await detect(stagedDir, baseline)).toEqual({ changed: true, output: '' });
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
