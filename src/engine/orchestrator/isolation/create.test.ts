import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../../core/config/load/io.js';
import {
  isolationWorktreePath,
  isolationWorktreeRoot,
  SANDBOX_DIR,
  SPLITBRIEF_DIR,
} from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import { createGitClient } from '../../../lib/git/client.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { createRunnerSandboxEnv, sandboxCredentialValues } from '../../runners/sandbox-env.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir as removeTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createRunIsolation } from './create.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const SESSION_ID = '2026-08-05-isolation-create-test';
const SLUG = SESSION_ID.slice(0, 64);
const config = createDefaultConfig();
const CODEX_TOKEN = 'codex-worktree-session-canary-91ac';
// Copilot rather than Claude Code: this file is about bridging topology across
// roles and profiles, and copilot's session credential is a file on every
// platform. The Claude Code session channel reads the macOS login keychain, so
// there it has no snapshot for these assertions to be about.
const COPILOT_TOKEN = 'copilot-worktree-session-canary-4f9d';
const CODEX_STATE = JSON.stringify({ token: CODEX_TOKEN });
const COPILOT_STATE = JSON.stringify({ token: COPILOT_TOKEN });
const REAL_HOME = process.env.HOME;
const REAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const REAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let testStateHome: string;

function acquireDirect(handle: ReturnType<typeof createRunIsolation>) {
  return handle.acquire({ role: 'implementer', config, writesFiles: 'direct' });
}

const isolationRoot = (dir: string): string =>
  isolationWorktreeRoot(realpathSync(join(dir, '.git')));

const isolationWorktree = (dir: string): string =>
  isolationWorktreePath(realpathSync(join(dir, '.git')), SLUG);

function cleanupTempDir(dir: string): void {
  if (existsSync(join(dir, '.git'))) {
    rmSync(isolationRoot(dir), { recursive: true, force: true });
  }
  removeTempDir(dir);
}

/** A host HOME holding two tools' session state, so a bridge has something to copy. */
function useHostHome(): string {
  const hostHome = createTempDir('isolation-host-home');
  mkdirSync(join(hostHome, '.codex'), { recursive: true });
  mkdirSync(join(hostHome, '.copilot'), { recursive: true });
  writeFileSync(join(hostHome, '.codex', 'auth.json'), CODEX_STATE);
  writeFileSync(join(hostHome, '.copilot', 'config.json'), COPILOT_STATE);
  process.env.HOME = hostHome;
  return hostHome;
}

function withRunners(planner: Config['planner'], implementer: Config['implementer']): Config {
  return { ...config, planner, implementer };
}

const API_PLANNER: Config['planner'] = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://localhost:11434/v1',
  contextLength: 32768,
  temperature: 0.2,
};

/** The pair both flagship CLIs ship: one tool, one channel per role. */
const SAME_TOOL_SPLIT_CHANNELS = withRunners(
  { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
  { kind: 'cli', tool: 'codex', authChannel: 'session' },
);

beforeEach(() => {
  testStateHome = createTempDir('isolation-state-home');
  process.env.XDG_STATE_HOME = testStateHome;
});

afterEach(() => {
  removeTempDir(testStateHome);
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  if (REAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = REAL_XDG_STATE_HOME;
  if (REAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = REAL_OPENAI_API_KEY;
});

describe('createRunIsolation', () => {
  it('hands two acquisitions in one run the same working directory, each with its own baseline', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-two-acq');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const first = await acquireDirect(handle);
      writeFileSync(join(first.projectDir, 'a.txt'), 'A\n');
      const second = await acquireDirect(handle);

      expect(second.projectDir).toBe(first.projectDir);
      expect(readdirSync(isolationRoot(dir))).toHaveLength(1);

      writeFileSync(join(second.projectDir, 'b.txt'), 'B\n');
      expect(await getChangedFilesSinceSnapshot(first.projectDir, first.snapshot)).toEqual([
        'a.txt',
        'b.txt',
      ]);
      expect(await getChangedFilesSinceSnapshot(second.projectDir, second.snapshot)).toEqual([
        'b.txt',
      ]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('hands an extracted-code implementer a temporary copy even when the strategy is worktree', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-extracted');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await handle.acquire({
        role: 'implementer',
        config,
        writesFiles: 'extracted-code',
      });

      expect(ws.projectDir).not.toBe(dir);
      expect(ws.snapshot.baselineFileHashes).toBeDefined();
      expect(existsSync(isolationRoot(dir))).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('falls back to the copying strategy for a repository without commits, reporting once', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-nocommit');
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
      writeFileSync(join(dir, 'init.txt'), 'init\n');

      const reasons: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: (reason) => reasons.push(reason),
        onRetained: () => {},
      });

      const first = await acquireDirect(handle);
      const second = await acquireDirect(handle);

      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/no commits/);
      expect(first.projectDir).not.toBe(dir);
      expect(existsSync(join(first.projectDir, 'init.txt'))).toBe(true);
      expect(second.projectDir).not.toBe(dir);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('reports an empty changed set on the first acquisition over a seeded worktree', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-seeded');
    try {
      createTestGitRepo(dir, { 'a.txt': 'base\n', 'gone.txt': 'delete me\n' });
      writeFileSync(join(dir, 'a.txt'), 'edited\n');
      writeFileSync(join(dir, 'new.txt'), 'untracked\n');
      rmSync(join(dir, 'gone.txt'));

      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      expect(ws.snapshot.baselineFileHashes).toBeUndefined();
      expect(await getChangedFilesSinceSnapshot(ws.projectDir, ws.snapshot)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('carries baseline file hashes on a staged-copy workspace but not on a worktree workspace', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-hashes');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });

      const worktreeHandle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });
      const worktreeWs = await acquireDirect(worktreeHandle);
      expect(worktreeWs.snapshot.baselineFileHashes).toBeUndefined();

      const stagedHandle = createRunIsolation({
        projectDir: dir,
        sessionId: `${SESSION_ID}-staged`,
        strategy: 'staged-copy',
        onFallback: () => {},
        onRetained: () => {},
      });
      const stagedWs = await acquireDirect(stagedHandle);
      expect(stagedWs.snapshot.baselineFileHashes).toBeDefined();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('falls back instead of seeding a modified binary file', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-binary');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', 'blob.bin': 'text\n' });
      writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x81]));

      const reasons: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: (reason) => reasons.push(reason),
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/binary/);
      expect(ws.projectDir).not.toBe(dir);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('falls back when a source directory is a symlink', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-symlink');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      mkdirSync(join(dir, 'real-dir'));
      symlinkSync(join(dir, 'real-dir'), join(dir, 'linked'), 'dir');

      const reasons: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: (reason) => reasons.push(reason),
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/symlink/i);
      expect(ws.projectDir).not.toBe(dir);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('clears bridged credential files from the worktree sandbox on dispose', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-credentials');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      const credential = join(
        ws.projectDir,
        SPLITBRIEF_DIR,
        'sandbox',
        'implementer',
        config.implementer.kind === 'cli' ? config.implementer.tool : 'codex',
        'home',
        '.codex',
        'auth.json',
      );
      mkdirSync(dirname(credential), { recursive: true });
      writeFileSync(credential, '{"tokens":{"access_token":"secret-value-abcdefghijklmnop"}}');
      writeFileSync(join(ws.projectDir, 'unpromoted.txt'), 'work\n');

      await handle.dispose();

      expect(existsSync(credential)).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('dispose removes the sandbox npm-cache contents under the project sandbox root', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-npm-cache');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      // The planner runs in the project, not the worktree, so its cache is the
      // one nothing else reclaims — the worktree's goes with the worktree.
      const roleRoot = join(dir, SANDBOX_DIR, 'planner', 'codex');
      const npmCache = join(roleRoot, 'npm-cache');
      mkdirSync(npmCache, { recursive: true });
      writeFileSync(join(npmCache, 'cached-package.tgz'), 'cached\n');
      expect(ws.projectDir).not.toBe(dir);

      await handle.dispose();

      expect(existsSync(join(npmCache, 'cached-package.tgz'))).toBe(false);
      expect(existsSync(npmCache)).toBe(false);
      expect(existsSync(roleRoot)).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix(
    'keeps the implementer bridge alive across a planner acquisition in one worktree',
    { timeout: 60_000 },
    async () => {
      const dir = createTempDir('isolation-two-role-credentials');
      const hostHome = useHostHome();
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        const twoCli = withRunners(
          { kind: 'cli', tool: 'copilot', authChannel: 'session' },
          { kind: 'cli', tool: 'codex', authChannel: 'session' },
        );
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: () => {},
        });

        const first = await handle.acquire({
          role: 'implementer',
          config: twoCli,
          writesFiles: 'direct',
        });
        const codexAuth = join(first.sandboxEnv.HOME as string, '.codex', 'auth.json');
        expect(existsSync(codexAuth)).toBe(true);

        const planner = await handle.acquire({
          role: 'planner',
          config: twoCli,
          writesFiles: 'direct',
        });
        const second = await handle.acquire({
          role: 'implementer',
          config: twoCli,
          writesFiles: 'direct',
        });

        expect(existsSync(join(planner.sandboxEnv.HOME as string, '.copilot', 'config.json'))).toBe(
          true,
        );
        expect(readFileSync(codexAuth, 'utf8')).toBe(CODEX_STATE);
        expect(second.sandboxEnv).toBe(first.sandboxEnv);
      } finally {
        cleanupTempDir(hostHome);
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'keeps the implementer bridge alive across an api planner acquisition in one worktree',
    { timeout: 60_000 },
    async () => {
      const dir = createTempDir('isolation-api-planner-credentials');
      const hostHome = useHostHome();
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        const apiPlanner = withRunners(API_PLANNER, {
          kind: 'cli',
          tool: 'codex',
          authChannel: 'session',
        });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: () => {},
        });

        const implementer = await handle.acquire({
          role: 'implementer',
          config: apiPlanner,
          writesFiles: 'direct',
        });
        const codexAuth = join(implementer.sandboxEnv.HOME as string, '.codex', 'auth.json');
        expect(existsSync(codexAuth)).toBe(true);

        await handle.acquire({ role: 'planner', config: apiPlanner, writesFiles: 'direct' });

        expect(readFileSync(codexAuth, 'utf8')).toBe(CODEX_STATE);
      } finally {
        cleanupTempDir(hostHome);
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'keeps a same-tool api-key planner acquisition off the session implementer snapshot',
    { timeout: 60_000 },
    async () => {
      const dir = createTempDir('isolation-split-channel-session-first');
      const hostHome = useHostHome();
      process.env.OPENAI_API_KEY = 'sk-openai-split-channel';
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: () => {},
        });

        const implementer = await handle.acquire({
          role: 'implementer',
          config: SAME_TOOL_SPLIT_CHANNELS,
          writesFiles: 'direct',
        });
        const codexAuth = join(implementer.sandboxEnv.HOME as string, '.codex', 'auth.json');
        expect(existsSync(codexAuth)).toBe(true);

        const planner = await handle.acquire({
          role: 'planner',
          config: SAME_TOOL_SPLIT_CHANNELS,
          writesFiles: 'direct',
        });

        expect(readFileSync(codexAuth, 'utf8')).toBe(CODEX_STATE);
        expect(planner.sandboxEnv.HOME).not.toBe(implementer.sandboxEnv.HOME);
        expect(planner.sandboxEnv.OPENAI_API_KEY).toBe('sk-openai-split-channel');
      } finally {
        cleanupTempDir(hostHome);
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'never bridges a session implementer snapshot into a same-tool api-key planner HOME',
    { timeout: 60_000 },
    async () => {
      const dir = createTempDir('isolation-split-channel-api-key-first');
      const hostHome = useHostHome();
      process.env.OPENAI_API_KEY = 'sk-openai-split-channel';
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: () => {},
        });

        const planner = await handle.acquire({
          role: 'planner',
          config: SAME_TOOL_SPLIT_CHANNELS,
          writesFiles: 'direct',
        });
        const implementer = await handle.acquire({
          role: 'implementer',
          config: SAME_TOOL_SPLIT_CHANNELS,
          writesFiles: 'direct',
        });

        expect(existsSync(join(planner.sandboxEnv.HOME as string, '.codex', 'auth.json'))).toBe(
          false,
        );
        expect(sandboxCredentialValues(planner.sandboxEnv)).toEqual([]);
        expect(
          readFileSync(join(implementer.sandboxEnv.HOME as string, '.codex', 'auth.json'), 'utf8'),
        ).toBe(CODEX_STATE);
      } finally {
        cleanupTempDir(hostHome);
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'builds each implementer profile the environment its own runner selects',
    { timeout: 60_000 },
    async () => {
      const dir = createTempDir('isolation-two-profiles');
      const hostHome = useHostHome();
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: () => {},
        });

        const codexProfile = await handle.acquire({
          role: 'implementer',
          config: withRunners(config.planner, {
            kind: 'cli',
            tool: 'codex',
            authChannel: 'session',
          }),
          writesFiles: 'direct',
        });
        const copilotProfile = await handle.acquire({
          role: 'implementer',
          config: withRunners(config.planner, {
            kind: 'cli',
            tool: 'copilot',
            authChannel: 'session',
          }),
          writesFiles: 'direct',
        });

        expect(copilotProfile.sandboxEnv).not.toBe(codexProfile.sandboxEnv);
        expect(sandboxCredentialValues(codexProfile.sandboxEnv)).toContain(CODEX_TOKEN);
        expect(sandboxCredentialValues(codexProfile.sandboxEnv)).not.toContain(COPILOT_TOKEN);
        expect(sandboxCredentialValues(copilotProfile.sandboxEnv)).toContain(COPILOT_TOKEN);
        expect(JSON.stringify(copilotProfile.sandboxEnv)).not.toContain(COPILOT_TOKEN);
      } finally {
        cleanupTempDir(hostHome);
        cleanupTempDir(dir);
      }
    },
  );

  it('leaves the repository excludes exactly as it found them once the run disposes', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-exclude-restore');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      const excludeFile = join(dir, '.git', 'info', 'exclude');
      const before = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      expect(ws.projectDir).toBe(isolationWorktree(dir));
      expect(readFileSync(excludeFile, 'utf8')).toContain(SESSION_ID);

      await handle.dispose();

      expect(readFileSync(excludeFile, 'utf8')).toBe(before);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('removes the worktree, its branch and the emptied repository directory when nothing unpromoted remains', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-retain-accepted');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const retained: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: (worktreeDir) => retained.push(worktreeDir),
      });

      const ws = await acquireDirect(handle);
      mkdirSync(join(ws.projectDir, 'src'), { recursive: true });
      writeFileSync(join(ws.projectDir, 'src', 'app.ts'), 'export const app = true;\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');

      await handle.dispose();

      expect(retained).toEqual([]);
      expect(existsSync(isolationWorktree(dir))).toBe(false);
      expect(existsSync(isolationRoot(dir))).toBe(false);
      expect((await createGitClient(dir).branch()).all).not.toContain(`splitbrief/${SLUG}`);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('removes the worktree when a seeded project file keeps changing during the run', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-live-log');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      // An untracked file the operator appends to for the whole run — the
      // run's own event log in the incident this guards against.
      writeFileSync(join(dir, 'run.ndjson'), 'line1\n');
      const retained: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: (worktreeDir) => retained.push(worktreeDir),
      });

      const ws = await acquireDirect(handle);
      // Task work, promoted: identical content in worktree and project.
      writeFileSync(join(ws.projectDir, 'a.txt'), 'A\n');
      writeFileSync(join(dir, 'a.txt'), 'A\n');
      // The project-side log grew after the worktree was seeded.
      writeFileSync(join(dir, 'run.ndjson'), 'line1\nline2\n');

      await handle.dispose();

      expect(retained).toEqual([]);
      expect(existsSync(isolationWorktree(dir))).toBe(false);
      expect((await createGitClient(dir).branch()).all).not.toContain(`splitbrief/${SLUG}`);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('dispose after full promotion emits no uncommitted-files warning', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-promoted-no-warn');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      writeFileSync(join(dir, 'run.ndjson'), 'line1\n');
      const warningPublisher = vi.fn();
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
        warningPublisher,
      });

      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'a.txt'), 'A\n');
      writeFileSync(join(dir, 'a.txt'), 'A\n');
      writeFileSync(join(dir, 'run.ndjson'), 'line1\nline2\n');

      await handle.dispose();

      const stderrText = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText).not.toContain('uncommitted file');
      const publishedText = warningPublisher.mock.calls.map((call) => String(call[0])).join('');
      expect(publishedText).not.toContain('uncommitted file');
      expect(existsSync(isolationWorktree(dir))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      cleanupTempDir(dir);
    }
  });

  it('retains the worktree when the run rewrites a seeded file without promoting it', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-seeded-rewrite');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      writeFileSync(join(dir, 'notes.txt'), 'draft\n');
      const retained: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: (worktreeDir) => retained.push(worktreeDir),
      });

      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'notes.txt'), 'rewritten by the run\n');

      await handle.dispose();

      expect(retained).toEqual([ws.projectDir]);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('retains the worktree and branch when unpromoted work remains, reporting it', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-retain-unpromoted');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const retained: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: (worktreeDir) => retained.push(worktreeDir),
      });

      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'unpromoted.txt'), 'work\n');

      await handle.dispose();

      expect(retained).toEqual([ws.projectDir]);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
      expect((await createGitClient(dir).branch()).all).toContain(`splitbrief/${SLUG}`);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('discards a gate-denied task from the worktree, leaving nothing to retain', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-gate-denied');
    try {
      createTestGitRepo(dir, { 'src/app.ts': 'export const app = true;\n' });
      const retained: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: (worktreeDir) => retained.push(worktreeDir),
      });

      const taskStartSnapshot = await getChangedFilesSnapshot(dir);
      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'src', 'app.ts'), 'export const app = "denied";\n');
      writeFileSync(join(ws.projectDir, 'src', 'extra.ts'), 'export const extra = true;\n');

      const task = makeTask({ id: 'T001', file: 'src/main.ts' });
      const outcome = await gateAndPromoteChangedFiles({
        task,
        state: makeImplState([task]),
        projectDir: dir,
        sessionId: SESSION_ID,
        bus: makeBusRecorder().bus,
        callbacks: makeCallbacks({
          onTieredApproval: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'test' }),
        }).callbacks,
        config: makeNoValidationConfig({
          approval: { enabled: true, feedRejectionsToPlanner: false },
        }),
        workspace: ws,
        usesIsolation: true,
        taskStartSnapshot,
        dependsOnFiles: [],
        cleanup: ws.cleanup,
        handleConflict: async (s) => s,
        onApproved: () => {},
      });
      expect(outcome.outcome).toBe('gate-denied');

      // The next acquisition observes the worktree the denial left behind.
      const next = await acquireDirect(handle);
      expect(readFileSync(join(next.projectDir, 'src', 'app.ts'), 'utf8')).toBe(
        'export const app = true;\n',
      );
      expect(existsSync(join(next.projectDir, 'src', 'extra.ts'))).toBe(false);

      await handle.dispose();

      expect(retained).toEqual([]);
      expect(existsSync(isolationWorktree(dir))).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('discards one task cleanup without touching the work an earlier task promoted', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-cleanup-scope');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const first = await acquireDirect(handle);
      writeFileSync(join(first.projectDir, 'a.txt'), 'A\n');
      // What promotion does to the real project once the gate allows the task.
      writeFileSync(join(dir, 'a.txt'), 'A\n');
      first.cleanup();

      const second = await acquireDirect(handle);
      expect(readFileSync(join(second.projectDir, 'a.txt'), 'utf8')).toBe('A\n');

      writeFileSync(join(second.projectDir, 'b.txt'), 'B\n');
      second.cleanup();

      const third = await acquireDirect(handle);
      expect(existsSync(join(third.projectDir, 'b.txt'))).toBe(false);
      expect(readFileSync(join(third.projectDir, 'a.txt'), 'utf8')).toBe('A\n');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('retains the worktree and warns when the unpromoted-work scan fails', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-scan-fail');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      // A symlink to an existing file makes the content read throw a
      // path-symlink-read confinement error, failing the scan.
      symlinkSync(join(ws.projectDir, 'README.md'), join(ws.projectDir, 'linked.txt'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        await expect(handle.dispose()).resolves.toBeUndefined();
        const warned = stderrSpy.mock.calls.some((call) => String(call[0]).includes(SESSION_ID));
        expect(warned).toBe(true);
        expect(existsSync(isolationWorktree(dir))).toBe(true);
        expect((await createGitClient(dir).branch()).all).toContain(`splitbrief/${SLUG}`);
      } finally {
        stderrSpy.mockRestore();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it.each([
    {
      label: 'a source file it cannot seed byte-identically',
      prepare: (dir: string) => {
        createTestGitRepo(dir, { 'README.md': '# test\n', 'blob.bin': 'text\n' });
        writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x81]));
      },
    },
    {
      label: 'a symlinked source directory',
      prepare: (dir: string) => {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        mkdirSync(join(dir, 'real-dir'));
        symlinkSync(join(dir, 'real-dir'), join(dir, 'linked'), 'dir');
      },
    },
    {
      label: 'a node_modules the repository does not ignore',
      prepare: (dir: string) => {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        mkdirSync(join(dir, 'node_modules'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'installed.txt'), 'dependency\n');
      },
    },
  ])(
    'removes the worktree it created when the run falls back over $label',
    {
      timeout: 60_000,
    },
    async ({ prepare }) => {
      const dir = createTempDir('isolation-fallback-cleanup');
      try {
        prepare(dir);
        const retained: string[] = [];
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: (worktreeDir) => retained.push(worktreeDir),
        });

        const ws = await acquireDirect(handle);
        expect(ws.projectDir).not.toBe(dir);
        expect(existsSync(isolationWorktree(dir))).toBe(true);

        await handle.dispose();

        expect(retained).toEqual([]);
        expect(existsSync(isolationWorktree(dir))).toBe(false);
        const branches = await createGitClient(dir).branch();
        expect(branches.all.filter((branch) => branch.startsWith('splitbrief/'))).toEqual([]);
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'runs a project .bin executable by bare name from a worktree workspace',
    { timeout: 60_000 },
    async () => {
      const dir = createTempDir('isolation-bin-run');
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n', '.gitignore': 'node_modules\n' });
        mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
        const sentinel = join(dir, 'node_modules', '.bin', 'sentinel');
        writeFileSync(sentinel, '#!/usr/bin/env node\nprocess.stdout.write("sentinel-ran");\n');
        chmodSync(sentinel, 0o755);

        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
          onRetained: () => {},
        });
        const ws = await acquireDirect(handle);

        const output = execFileSync('sentinel', [], { cwd: ws.projectDir, env: ws.sandboxEnv });
        expect(output.toString('utf8')).toBe('sentinel-ran');
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it('keeps the workspace env byte-identical when the project has no node_modules', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-no-deps');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);
      const expected = await createRunnerSandboxEnv(
        ws.projectDir,
        config.implementer,
        'implementer',
      );

      expect(ws.sandboxEnv.PATH).toBe(expected.PATH);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('widens the workspace PATH to the real project .bin through the dependency link', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-bin-path');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', '.gitignore': 'node_modules\n' });
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });

      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        onRetained: () => {},
      });
      const ws = await acquireDirect(handle);

      expect(lstatSync(join(ws.projectDir, 'node_modules')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(ws.projectDir, 'node_modules'))).toBe(join(dir, 'node_modules'));
      expect(ws.sandboxEnv.PATH?.split(delimiter)[0]).toBe(
        realpathSync(join(dir, 'node_modules', '.bin')),
      );
      expect(await getChangedFilesSinceSnapshot(ws.projectDir, ws.snapshot)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('falls back instead of letting the dependency link pollute change detection', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-unignored-deps');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      mkdirSync(join(dir, 'node_modules'), { recursive: true });

      const reasons: string[] = [];
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: (reason) => reasons.push(reason),
        onRetained: () => {},
      });

      const ws = await acquireDirect(handle);

      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/node_modules/);
      expect(ws.projectDir).not.toBe(dir);
      expect(existsSync(join(ws.projectDir, 'init.txt'))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
