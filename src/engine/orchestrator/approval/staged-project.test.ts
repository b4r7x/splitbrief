import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../../core/paths.js';
import { captureCurrentFileContents, getChangedFilesSinceSnapshot } from './file-snapshots.js';
import { createStagedProject, promoteStagedChanges } from './staged-project.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const touchedEnvKeys: string[] = [];

afterEach(() => {
  for (const key of touchedEnvKeys) delete process.env[key];
  touchedEnvKeys.length = 0;
});

describe('createStagedProject', () => {
  it('copies project files and leaves runtime directories out of the staged project', async () => {
    const dir = createTempDir('staged-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, '.diptych', 'sessions'), { recursive: true });
      mkdirSync(join(dir, '.diptych-sandbox', 'cache'), { recursive: true });
      mkdirSync(join(dir, '.trees', 'worktree'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'cache.js'), 'cache');
      writeFileSync(join(dir, '.diptych', 'sessions', 'state.json'), '{}');
      writeFileSync(join(dir, '.diptych-sandbox', 'cache', 'file'), 'cache');
      writeFileSync(join(dir, '.trees', 'worktree', 'file.ts'), 'tree');

      const staged = await createStagedProject(dir);
      let cleaned = false;
      try {
        expect(staged.projectDir).not.toBe(dir);
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(existsSync(join(staged.projectDir, 'node_modules'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.diptych'))).toBe(false);
        const sandboxHome = join(staged.projectDir, SANDBOX_DIR, 'home');
        const sandboxTmp = join(staged.projectDir, SANDBOX_DIR, 'tmp');
        const sandboxCache = join(staged.projectDir, SANDBOX_DIR, 'cache');
        const sandboxNpmCache = join(staged.projectDir, SANDBOX_DIR, 'npm-cache');
        expect(existsSync(join(sandboxCache, 'file'))).toBe(false);
        expect(staged.sandboxEnv.HOME).toBe(sandboxHome);
        expect(staged.sandboxEnv.TMPDIR).toBe(sandboxTmp);
        expect(staged.sandboxEnv.XDG_CACHE_HOME).toBe(sandboxCache);
        expect(staged.sandboxEnv.npm_config_cache).toBe(sandboxNpmCache);
        expect(existsSync(sandboxHome)).toBe(true);
        expect(existsSync(sandboxTmp)).toBe(true);
        expect(existsSync(join(staged.projectDir, '.trees'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.git'))).toBe(false);
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

  it('keeps original gitignore semantics when detecting staged changes without git metadata', async () => {
    const dir = createTempDir('staged-ignore-test');
    try {
      createTestGitRepo(dir);
      writeFileSync(join(dir, '.gitignore'), 'dist/\n*.log\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');

      const staged = await createStagedProject(dir);
      try {
        mkdirSync(join(staged.projectDir, 'dist'), { recursive: true });
        writeFileSync(join(staged.projectDir, 'dist', 'bundle.js'), 'ignored output\n');
        writeFileSync(join(staged.projectDir, 'debug.log'), 'ignored log\n');

        expect(await getChangedFilesSinceSnapshot(staged.projectDir, staged.snapshot)).toEqual([]);

        writeFileSync(join(staged.projectDir, 'src', 'app.ts'), 'export const app = false;\n');
        expect(await getChangedFilesSinceSnapshot(staged.projectDir, staged.snapshot)).toEqual([
          'src/app.ts',
        ]);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('detects a deleted baseline file and promotes the deletion to the real project', async () => {
    const dir = createTempDir('staged-delete-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      writeFileSync(join(dir, 'src', 'gone.ts'), 'export const gone = true;\n');

      const staged = await createStagedProject(dir);
      try {
        rmSync(join(staged.projectDir, 'src', 'gone.ts'));

        const changed = await getChangedFilesSinceSnapshot(staged.projectDir, staged.snapshot);
        expect(changed).toContain('src/gone.ts');

        const expectedCurrentContents = await captureCurrentFileContents(dir, changed);
        const promoted = await promoteStagedChanges({
          targetProjectDir: dir,
          stagedProjectDir: staged.projectDir,
          files: changed,
          expectedCurrentContents,
        });

        expect(promoted.conflictedFiles).toEqual([]);
        expect(promoted.promotedFiles).toContain('src/gone.ts');
        expect(existsSync(join(dir, 'src', 'gone.ts'))).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix('does not copy symlinked entries into the staged project', async () => {
    const dir = createTempDir('staged-symlink-test');
    const outsideDir = createTempDir('staged-symlink-outside');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outsideDir, 'outside.ts'), 'outside\n');
      symlinkSync(join(outsideDir, 'outside.ts'), join(dir, 'src', 'linked.ts'));

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'src', 'linked.ts'))).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(outsideDir);
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

  it("preserves the implementer's auth key by default while stripping planner credentials", async () => {
    const dir = createTempDir('staged-runner-auth-test');
    try {
      createTestGitRepo(dir);
      touchedEnvKeys.push(
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GITHUB_TOKEN',
        'AWS_PROFILE',
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'GIT_ASKPASS',
        'SSH_AUTH_SOCK',
        'npm_config_userconfig',
      );
      process.env.OPENAI_API_KEY = 'sk-openai';
      process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
      process.env.GITHUB_TOKEN = 'gh-secret';
      process.env.AWS_PROFILE = 'prod';
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/tmp/aws-token';
      process.env.GIT_ASKPASS = '/tmp/askpass';
      process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
      process.env.npm_config_userconfig = '/home/user/.npmrc';

      const config = makeConfig({
        implementer: {
          kind: 'api',
          provider: 'openai',
          apiBase: 'https://api.openai.com/v1',
          model: 'gpt-4',
        },
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet',
        },
      });

      const staged = await createStagedProject(dir, config);
      try {
        expect(staged.sandboxEnv.OPENAI_API_KEY).toBe('sk-openai');
        expect(staged.sandboxEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(staged.sandboxEnv.GITHUB_TOKEN).toBeUndefined();
        expect(staged.sandboxEnv.AWS_PROFILE).toBeUndefined();
        expect(staged.sandboxEnv.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
        expect(staged.sandboxEnv.GIT_ASKPASS).toBeUndefined();
        expect(staged.sandboxEnv.SSH_AUTH_SOCK).toBeUndefined();
        expect(staged.sandboxEnv.npm_config_userconfig).toBeUndefined();
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("preserves the planner's auth key for planner-owned staged calls", async () => {
    const dir = createTempDir('staged-planner-auth-test');
    try {
      createTestGitRepo(dir);
      touchedEnvKeys.push('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN');
      process.env.OPENAI_API_KEY = 'sk-openai';
      process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
      process.env.GITHUB_TOKEN = 'gh-secret';

      const config = makeConfig({
        implementer: {
          kind: 'api',
          provider: 'openai',
          apiBase: 'https://api.openai.com/v1',
          model: 'gpt-4',
        },
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet',
        },
      });

      const staged = await createStagedProject(dir, config, 'planner');
      try {
        expect(staged.sandboxEnv.ANTHROPIC_API_KEY).toBe('sk-anthropic');
        expect(staged.sandboxEnv.OPENAI_API_KEY).toBeUndefined();
        expect(staged.sandboxEnv.GITHUB_TOKEN).toBeUndefined();
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
