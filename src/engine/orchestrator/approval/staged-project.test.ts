import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_DIR, SPLITBRIEF_DIR, TREES_DIR } from '../../../core/paths.js';
import { listTrackedAndUntrackedFiles } from '../../../lib/git/files.js';
import { collectTrackedFiles } from '../../snapshots/files.js';
import { getChangedFilesSinceSnapshot } from './file-snapshots/capture.js';
import { captureCurrentFileContents } from './file-snapshots/contents.js';
import { createStagedProject, promoteStagedChanges } from './staged-project.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

vi.mock('../../../lib/git/files.js', { spy: true });

const itUnix = process.platform === 'win32' ? it.skip : it;

const touchedEnvKeys: string[] = [];

afterEach(() => {
  for (const key of touchedEnvKeys) delete process.env[key];
  touchedEnvKeys.length = 0;
  vi.mocked(listTrackedAndUntrackedFiles).mockRestore();
});

describe('createStagedProject', () => {
  it('copies project files and leaves runtime directories out of the staged project', async () => {
    const dir = createTempDir('staged-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, SPLITBRIEF_DIR, 'sessions'), { recursive: true });
      mkdirSync(join(dir, SANDBOX_DIR, 'cache'), { recursive: true });
      mkdirSync(join(dir, '.trees', 'worktree'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'cache.js'), 'cache');
      writeFileSync(join(dir, SPLITBRIEF_DIR, 'sessions', 'state.json'), '{}');
      writeFileSync(join(dir, SANDBOX_DIR, 'cache', 'file'), 'cache');
      writeFileSync(join(dir, '.trees', 'worktree', 'file.ts'), 'tree');

      const staged = await createStagedProject(dir);
      let cleaned = false;
      try {
        expect(staged.projectDir).not.toBe(dir);
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(existsSync(join(staged.projectDir, 'node_modules'))).toBe(false);
        expect(existsSync(join(staged.projectDir, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
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
    try {
      createTestGitRepo(dir);
      writeFileSync(join(dir, '.gitignore'), 'src/linked.ts\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      symlinkSync(join(dir, 'src', 'app.ts'), join(dir, 'src', 'linked.ts'));

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'src', 'linked.ts'))).toBe(false);
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('is not an OS sandbox: a staged child can write an absolute outside sentinel', async () => {
    const projectDir = createTempDir('staged-outside-sentinel-project');
    const outsideDir = createTempDir('staged-outside-sentinel-target');
    const sentinelPath = join(outsideDir, 'reachable-from-staged-child');
    try {
      createTestGitRepo(projectDir);
      const staged = await createStagedProject(projectDir);
      try {
        execFileSync(
          process.execPath,
          [
            '-e',
            "require('node:fs').writeFileSync(process.argv[1], 'outside-stage-reachable')",
            sentinelPath,
          ],
          { cwd: staged.projectDir, env: staged.sandboxEnv },
        );

        expect(readFileSync(sentinelPath, 'utf8')).toBe('outside-stage-reachable');
        rmSync(sentinelPath);
        expect(existsSync(sentinelPath)).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(outsideDir);
      cleanupTempDir(projectDir);
    }
  });

  it('copies no gitignored build or report output, and none appears in the change-detection walk', async () => {
    const dir = createTempDir('staged-gitignore-test');
    try {
      createTestGitRepo(dir, { 'src/app.ts': 'export const app = true;\n' });
      writeFileSync(join(dir, '.gitignore'), 'dist/\nreports/\n*.log\n');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      mkdirSync(join(dir, 'reports'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'bundle.js'), 'build output\n');
      writeFileSync(join(dir, 'reports', 'summary.html'), 'report output\n');
      writeFileSync(join(dir, 'debug.log'), 'log output\n');

      const staged = await createStagedProject(dir);
      try {
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(existsSync(join(staged.projectDir, 'dist'))).toBe(false);
        expect(existsSync(join(staged.projectDir, 'reports'))).toBe(false);
        expect(existsSync(join(staged.projectDir, 'debug.log'))).toBe(false);
        const walked = await collectTrackedFiles(staged.projectDir, { ignoreProjectDir: dir });
        expect(walked).toContain('src/app.ts');
        expect(walked).not.toContain('dist/bundle.js');
        expect(walked).not.toContain('reports/summary.html');
        expect(walked).not.toContain('debug.log');
        for (const file of staged.snapshot.files) {
          expect(existsSync(join(staged.projectDir, file))).toBe(true);
        }
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('excludes a file ignored only through .git/info/exclude', async () => {
    const dir = createTempDir('staged-info-exclude-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      writeFileSync(join(dir, '.git', 'info', 'exclude'), 'secret.txt\n');
      writeFileSync(join(dir, 'secret.txt'), 'local secret\n');
      writeFileSync(join(dir, 'public.txt'), 'public\n');

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'secret.txt'))).toBe(false);
        expect(readFileSync(join(staged.projectDir, 'public.txt'), 'utf-8')).toBe('public\n');
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('still excludes a tracked .env file', async () => {
    const dir = createTempDir('staged-tracked-env-test');
    try {
      createTestGitRepo(dir, {
        '.env': 'SECRET=tracked\n',
        'env.example': 'export const example = true;\n',
      });

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, '.env'))).toBe(false);
        expect(readFileSync(join(staged.projectDir, 'env.example'), 'utf-8')).toBe(
          'export const example = true;\n',
        );
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('copies entries at project-relative paths when the project is not the repository root', async () => {
    const dir = createTempDir('staged-subdir-test');
    try {
      createTestGitRepo(dir, { 'sub/init.txt': 'init\n', 'root.txt': 'outside\n' });
      mkdirSync(join(dir, 'sub', 'src'), { recursive: true });
      writeFileSync(join(dir, 'sub', 'src', 'app.ts'), 'export const app = true;\n');

      const staged = await createStagedProject(join(dir, 'sub'));
      try {
        expect(readFileSync(join(staged.projectDir, 'init.txt'), 'utf-8')).toBe('init\n');
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(existsSync(join(staged.projectDir, 'root.txt'))).toBe(false);
        expect(existsSync(join(staged.projectDir, 'sub', 'src', 'app.ts'))).toBe(false);
        const walked = await collectTrackedFiles(staged.projectDir, {
          ignoreProjectDir: join(dir, 'sub'),
        });
        expect(walked).toContain('src/app.ts');
        expect(walked).toContain('init.txt');
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('skips an embedded repository that git reports as an opaque directory', async () => {
    const dir = createTempDir('staged-embedded-repo-test');
    try {
      createTestGitRepo(dir);
      const embedded = join(dir, 'embedded');
      mkdirSync(embedded, { recursive: true });
      execSync('git init', { cwd: embedded, stdio: 'pipe' });
      writeFileSync(join(embedded, 'inner.txt'), 'inner\n');

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'embedded'))).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('stages a repository whose tracked file was deleted from the working tree', async () => {
    const dir = createTempDir('staged-deleted-tracked-test');
    try {
      createTestGitRepo(dir, {
        'src/app.ts': 'export const app = true;\n',
        'src/gone.ts': 'export const gone = true;\n',
      });
      rmSync(join(dir, 'src', 'gone.ts'));
      expect(await listTrackedAndUntrackedFiles(dir)).toContain('src/gone.ts');

      const staged = await createStagedProject(dir);
      try {
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(readFileSync(join(staged.projectDir, 'init.txt'), 'utf-8')).toBe('init');
        expect(existsSync(join(staged.projectDir, 'src', 'gone.ts'))).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('skips a submodule gitlink, which git lists without a trailing slash', async () => {
    const upstream = createTempDir('staged-submodule-upstream');
    const dir = createTempDir('staged-submodule-test');
    try {
      createTestGitRepo(upstream, { 'inner.txt': 'inner\n' });
      createTestGitRepo(dir, { 'src/app.ts': 'export const app = true;\n' });
      execFileSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'sub'],
        { cwd: dir, stdio: 'pipe' },
      );
      expect(await listTrackedAndUntrackedFiles(dir)).toContain('sub');

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'sub'))).toBe(false);
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(readFileSync(join(staged.projectDir, '.gitmodules'), 'utf-8')).toContain('sub');
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
      cleanupTempDir(upstream);
    }
  });

  itUnix('does not copy a symlinked entry that git tracks', async () => {
    const dir = createTempDir('staged-tracked-symlink-test');
    try {
      createTestGitRepo(dir);
      writeFileSync(join(dir, 'real.txt'), 'real\n');
      symlinkSync('real.txt', join(dir, 'link.txt'));
      execSync('git add real.txt link.txt', { cwd: dir, stdio: 'pipe' });
      execSync('git commit -m "add symlink"', { cwd: dir, stdio: 'pipe' });

      const staged = await createStagedProject(dir);
      try {
        expect(existsSync(join(staged.projectDir, 'link.txt'))).toBe(false);
        expect(readFileSync(join(staged.projectDir, 'real.txt'), 'utf-8')).toBe('real\n');
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('falls back to a full recursive copy when the git file list is unavailable', async () => {
    vi.mocked(listTrackedAndUntrackedFiles).mockResolvedValue(null);
    const dir = createTempDir('staged-gitlist-fallback-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'cache.js'), 'cache');
      writeFileSync(join(dir, '.env'), 'SECRET=canary\n');

      const staged = await createStagedProject(dir);
      try {
        expect(readFileSync(join(staged.projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
          'export const app = true;\n',
        );
        expect(existsSync(join(staged.projectDir, 'node_modules'))).toBe(false);
        expect(existsSync(join(staged.projectDir, '.env'))).toBe(false);
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('createStagedProject — sensitive file exclusion', () => {
  it.each([
    'planner',
    'implementer',
  ] as const)('recursively excludes .env* files for the %s stage without excluding boundary names', async (runnerRole) => {
    const dir = createTempDir('staged-env-test');
    try {
      createTestGitRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
      const excluded = [
        '.env',
        '.env.local',
        '.env.production',
        '.envrc',
        'nested/.env',
        'nested/.env.local',
        'nested/deep/.envrc',
      ];
      const retained = ['env', 'app.env', 'config.env', 'nested/config.env'];
      for (const file of excluded) writeFileSync(join(dir, file), 'SECRET=canary\n');
      for (const file of retained) writeFileSync(join(dir, file), 'public boundary\n');

      const staged = await createStagedProject(
        dir,
        makeConfig({
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
        }),
        runnerRole,
      );
      try {
        expect(existsSync(join(staged.projectDir, 'src', 'app.ts'))).toBe(true);
        for (const file of excluded) {
          expect(existsSync(join(staged.projectDir, file))).toBe(false);
        }
        for (const file of retained) {
          expect(readFileSync(join(staged.projectDir, file), 'utf8')).toBe('public boundary\n');
        }
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

  it('uses only the selected CLI auth channel in a staged implementer', async () => {
    const dir = createTempDir('staged-cli-auth-test');
    const hostHome = createTempDir('staged-cli-host-home');
    const originalHome = process.env.HOME;
    try {
      createTestGitRepo(dir);
      touchedEnvKeys.push('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
      process.env.HOME = hostHome;
      process.env.OPENAI_API_KEY = 'sk-openai';
      process.env.ANTHROPIC_API_KEY = 'sk-anthropic';

      const session = await createStagedProject(
        dir,
        makeConfig({
          implementer: { kind: 'cli', tool: 'codex', authChannel: 'session' },
        }),
      );
      const apiKey = await createStagedProject(
        dir,
        makeConfig({
          implementer: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
        }),
      );
      try {
        expect(session.sandboxEnv.HOME).toBe(
          join(session.projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home'),
        );
        expect(session.sandboxEnv.OPENAI_API_KEY).toBeUndefined();
        expect(session.sandboxEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(apiKey.sandboxEnv.HOME).toBe(
          join(apiKey.projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home'),
        );
        expect(apiKey.sandboxEnv.OPENAI_API_KEY).toBe('sk-openai');
        expect(apiKey.sandboxEnv.ANTHROPIC_API_KEY).toBeUndefined();
      } finally {
        session.cleanup();
        apiKey.cleanup();
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      cleanupTempDir(hostHome);
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
