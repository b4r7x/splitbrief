import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPLITBRIEF_DIR, TREES_DIR } from '../../../core/paths.js';
import { promoteStagedChanges } from './staged-project.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('promoteStagedChanges', () => {
  it('copies staged content only when the original file still matches the expected snapshot', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['src/app.ts'],
        expectedCurrentContents: { 'src/app.ts': 'original\n' },
      });

      expect(promoted).toEqual({ promotedFiles: ['src/app.ts'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('staged\n');
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('promotes a task edit to .gitignore without the isolation bookkeeping lines', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const original = 'node_modules/\ndist/\n';
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(
        join(stagedDir, '.gitignore'),
        `${original}${SPLITBRIEF_DIR}/\n${TREES_DIR}/\ncoverage/\n`,
      );

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        expectedCurrentContents: { '.gitignore': original },
      });

      expect(promoted).toEqual({ promotedFiles: ['.gitignore'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(`${original}coverage/\n`);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('keeps a bookkeeping entry the project .gitignore already carried', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const original = `node_modules/\n${SPLITBRIEF_DIR}/\n`;
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(join(stagedDir, '.gitignore'), `${original}${TREES_DIR}/\ncoverage/\n`);

      await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        expectedCurrentContents: { '.gitignore': original },
      });

      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(`${original}coverage/\n`);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('drops a task-authored bookkeeping entry the project .gitignore did not already carry', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      // The strip cannot tell this line from the one isolation appended, so the
      // task's own addition is dropped rather than risk writing SPLITBRIEF's
      // bookkeeping into a tracked file. Adding it stays a manual step.
      const original = 'node_modules/\n';
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(join(stagedDir, '.gitignore'), `${original}${TREES_DIR}/\n`);

      await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        expectedCurrentContents: { '.gitignore': original },
      });

      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(original);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('promotes a file other than .gitignore verbatim when it lists the same entries', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const body = `ignored:\n${SPLITBRIEF_DIR}/\n${TREES_DIR}/\n`;
      writeFileSync(join(stagedDir, 'notes.md'), body);

      await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['notes.md'],
        expectedCurrentContents: { 'notes.md': null },
      });

      expect(readFileSync(join(projectDir, 'notes.md'), 'utf-8')).toBe(body);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('keeps local edits when promotion detects a conflict', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'user edit\n');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['src/app.ts'],
        expectedCurrentContents: { 'src/app.ts': 'original\n' },
      });

      expect(promoted).toEqual({ promotedFiles: [], conflictedFiles: ['src/app.ts'] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('user edit\n');
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('rejects changed file paths that escape the target project', async () => {
    const targetRoot = createTempDir('promote-target-root');
    const stagedRoot = createTempDir('promote-staged-root');
    const projectDir = join(targetRoot, 'project');
    const stagedDir = join(stagedRoot, 'staged');
    try {
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(stagedDir, { recursive: true });
      writeFileSync(join(stagedRoot, 'escape.ts'), 'staged escape\n');

      await expect(
        promoteStagedChanges({
          targetProjectDir: projectDir,
          stagedProjectDir: stagedDir,
          files: ['../escape.ts'],
          expectedCurrentContents: { '../escape.ts': null },
        }),
      ).rejects.toThrow(/unsafe path/);

      expect(existsSync(join(targetRoot, 'escape.ts'))).toBe(false);
    } finally {
      cleanupTempDir(stagedRoot);
      cleanupTempDir(targetRoot);
    }
  });

  itUnix('does not promote through a symlinked target parent outside the project', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    const outsideDir = createTempDir('promote-outside');
    try {
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');
      symlinkSync(outsideDir, join(projectDir, 'src'));

      await expect(
        promoteStagedChanges({
          targetProjectDir: projectDir,
          stagedProjectDir: stagedDir,
          files: ['src/app.ts'],
          expectedCurrentContents: { 'src/app.ts': null },
        }),
      ).rejects.toThrow(/unsafe path/);

      expect(existsSync(join(outsideDir, 'app.ts'))).toBe(false);
    } finally {
      cleanupTempDir(outsideDir);
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });
});
