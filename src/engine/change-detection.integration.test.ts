import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createChangeDetector,
  captureChangeDetectorBaseline,
  summarizeChanges,
} from './change-detection.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

describe('file-hash change detection', () => {
  it.each(['clean', 'dirty-content', 'dirty-mode'] as const)(
    'detects a mode-only change from a %s git-status baseline',
    async (initial) => {
      const dir = createTempDir('change-detect-mode');
      try {
        createTestGitRepo(dir, { 'script.sh': 'echo hello\n' });
        const file = join(dir, 'script.sh');
        chmodSync(file, initial === 'dirty-mode' ? 0o755 : 0o644);
        if (initial === 'dirty-content') writeFileSync(file, 'echo changed\n');
        const baseline = await captureChangeDetectorBaseline(dir, { kind: 'git-status' });
        const detect = createChangeDetector('Direct implementer');
        expect(await detect(dir, baseline)).toMatchObject({ changed: false });

        chmodSync(file, initial === 'dirty-mode' ? 0o644 : 0o755);

        expect(await detect(dir, baseline)).toEqual({ changed: true, output: '' });
        expect(await summarizeChanges(dir, baseline)).toEqual({
          files: ['script.sh'],
          linesAdded: 0,
          linesRemoved: 0,
        });
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it.each(['clean', 'dirty'] as const)(
    'detects a binary-only change from a %s git-status baseline',
    async (initial) => {
      const dir = createTempDir('change-detect-binary');
      try {
        createTestGitRepo(dir, { 'data.bin': Buffer.from([0x00, 0x80]) });
        const file = join(dir, 'data.bin');
        if (initial === 'dirty') writeFileSync(file, Buffer.from([0x00, 0x82]));
        const baseline = await captureChangeDetectorBaseline(dir, { kind: 'git-status' });
        const detect = createChangeDetector('Direct implementer');
        expect(await detect(dir, baseline)).toMatchObject({ changed: false });

        writeFileSync(file, Buffer.from([0x00, 0x81]));

        expect(await detect(dir, baseline)).toEqual({ changed: true, output: '' });
        expect(await summarizeChanges(dir, baseline)).toEqual({
          files: ['data.bin'],
          linesAdded: 0,
          linesRemoved: 0,
        });
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it.each(['git-status', 'file-hashes'] as const)(
    'reports only the call changes in brief order for a %s baseline',
    async (kind) => {
      const dir = createTempDir('change-detect-files');
      try {
        createTestGitRepo(dir, {
          'src/text.js': 'old source\n',
          'test/text.test.js': 'old test\n',
          'src/untouched.js': 'clean\n',
        });
        writeFileSync(join(dir, 'src/text.js'), 'dirty source\n');
        writeFileSync(join(dir, 'src/untouched.js'), 'dirty and untouched\n');
        const baseline = await captureChangeDetectorBaseline(dir, { kind });
        writeFileSync(join(dir, 'src/text.js'), 'new source\nsecond line\n');
        writeFileSync(join(dir, 'test/text.test.js'), 'new test\n');
        writeFileSync(join(dir, 'z-extra.js'), 'extra');
        writeFileSync(join(dir, 'a-extra.js'), 'extra');

        const changes = await summarizeChanges(dir, baseline, ['src/text.js', 'test/text.test.js']);
        expect(changes).toEqual({
          files: ['src/text.js', 'test/text.test.js', 'a-extra.js', 'z-extra.js'],
          ...(kind === 'git-status' ? { linesAdded: 5, linesRemoved: 2 } : {}),
        });
        expect(await createChangeDetector('Direct implementer')(dir, baseline)).toEqual({
          changed: true,
          output: '',
        });
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

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
      expect(inferred).toMatchObject({ kind: 'git-status', files: ['src/app.ts'] });
      const declared = await captureChangeDetectorBaseline(repoDir, { kind: 'file-hashes' });
      expect(declared.kind).toBe('file-hashes');
      const detect = createChangeDetector('Direct implementer');

      writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const app = 2;\n');

      expect(await detect(repoDir, declared)).toEqual({ changed: true, output: '' });
      expect(await detect(repoDir, inferred)).toEqual({ changed: true, output: '' });
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
