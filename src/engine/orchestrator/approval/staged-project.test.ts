import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStagedProject, promoteStagedChanges } from './staged-project.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

describe('createStagedProject', () => {
  it('copies project files and leaves runtime directories out of the staged project', async () => {
    const dir = createTempDir('staged-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, '.diptych', 'sessions'), { recursive: true });
      mkdirSync(join(dir, '.trees', 'worktree'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'cache.js'), 'cache');
      writeFileSync(join(dir, '.diptych', 'sessions', 'state.json'), '{}');
      writeFileSync(join(dir, '.trees', 'worktree', 'file.ts'), 'tree');

      const staged = await createStagedProject(dir);
      let cleaned = false;
      try {
        expect(staged.projectDir).not.toBe(dir);
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe('export const app = true;\n');
        expect(existsSync(join(staged.projectDir, 'node_modules'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.diptych'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.trees'))).toBe(false);
        expect(staged.snapshot.files).toContain('src/app.ts');
        staged.cleanup();
        cleaned = true;
        expect(existsSync(staged.projectDir)).toBe(false);
      } finally {
        if (!cleaned) staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('createStagedProject — sensitive file exclusion', () => {
  it('excludes .env files from the staged copy', async () => {
    const dir = createTempDir('staged-env-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      writeFileSync(join(dir, '.env'), 'SECRET=abc\n');
      writeFileSync(join(dir, '.env.local'), 'LOCAL_SECRET=xyz\n');
      writeFileSync(join(dir, '.env.production'), 'PROD_SECRET=123\n');

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'src', 'app.ts'))).toBe(true);
        expect(existsSync(join(staged.projectDir, '.env'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.env.local'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.env.production'))).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('promoteStagedChanges', () => {
  it('copies staged content only when the original file still matches the expected snapshot', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');

      const promoted = await promoteStagedChanges(projectDir, stagedDir, ['src/app.ts'], {
        'src/app.ts': 'original\n',
      });

      expect(promoted).toEqual({ promotedFiles: ['src/app.ts'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('staged\n');
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

      const promoted = await promoteStagedChanges(projectDir, stagedDir, ['src/app.ts'], {
        'src/app.ts': 'original\n',
      });

      expect(promoted).toEqual({ promotedFiles: [], conflictedFiles: ['src/app.ts'] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('user edit\n');
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });
});
