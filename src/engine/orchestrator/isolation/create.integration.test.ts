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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import {
  isolationWorktreePath,
  isolationWorktreeRoot,
  SANDBOX_DIR,
  SESSIONS_DIR,
  sessionDir,
  SPLITBRIEF_DIR,
  STATE_FILE,
} from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import { createGitClient } from '../../../lib/git/client.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { gateAttemptChanges } from '../task/attempt-gate.js';
import { createRunnerSandboxEnv } from '../../runners/sandbox-env.js';
import { sandboxCredentialValues } from '../../runners/sandbox-credential-values.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCallbacks, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir as removeTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from './acquisition.js';
import { createRunIsolation } from './create.js';
import { removeRunWorkspace } from './remove-worktree.js';
import { readWorkspaceRecord } from './retention.js';

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
  return handle.acquire({ role: 'implementer', config });
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
  it('hands two acquisitions in one run the same working directory, with an attempt snapshot for each call', {
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
      });
      const worktreeWs = await acquireDirect(worktreeHandle);
      expect(worktreeWs.snapshot.baselineFileHashes).toBeUndefined();

      const stagedHandle = createRunIsolation({
        projectDir: dir,
        sessionId: `${SESSION_ID}-staged`,
        strategy: 'staged-copy',
        onFallback: () => {},
      });
      const stagedWs = await acquireDirect(stagedHandle);
      expect(stagedWs.snapshot.baselineFileHashes).toBeDefined();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('seeds modified binary bytes without falling back', { timeout: 60_000 }, async () => {
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
      });

      const ws = await acquireDirect(handle);
      expect(reasons).toHaveLength(0);
      expect(readFileSync(join(ws.projectDir, 'blob.bin'))).toEqual(
        Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x81]),
      );
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
      });

      const ws = await acquireDirect(handle);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/symlink/i);
      expect(ws.projectDir).not.toBe(dir);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('keeps the worktree over a source symlink that stays inside the project, in a continued run too', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-project-link');
    try {
      createTestGitRepo(dir, {
        '.claude/settings.json': '{}\n',
        'skills/babysit/SKILL.md': '# babysit\n',
      });
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      symlinkSync('../../skills/babysit', join(dir, '.claude', 'skills', 'babysit'), 'dir');
      const reasons: string[] = [];
      const isolation = () =>
        createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: (reason) => reasons.push(reason),
        });

      const first = await acquireDirect(isolation());
      expect(first.projectDir).toBe(isolationWorktree(dir));
      expect(readlinkSync(join(first.projectDir, '.claude', 'skills', 'babysit'))).toBe(
        '../../skills/babysit',
      );
      expect(await getChangedFilesSinceSnapshot(first.projectDir, first.snapshot)).toEqual([]);

      const continued = isolation();
      const fresh = await continued.acquire({
        role: 'implementer',
        config,
      });
      expect(fresh.projectDir).toBe(first.projectDir);
      await continued.dispose();

      expect(reasons).toEqual([]);
      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(false);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
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
        });

        const first = await handle.acquire({
          role: 'implementer',
          config: twoCli,
        });
        const codexAuth = join(first.sandboxEnv.HOME as string, '.codex', 'auth.json');
        expect(existsSync(codexAuth)).toBe(true);

        const planner = await handle.acquire({
          role: 'planner',
          config: twoCli,
        });
        const second = await handle.acquire({
          role: 'implementer',
          config: twoCli,
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
        });

        const implementer = await handle.acquire({
          role: 'implementer',
          config: apiPlanner,
        });
        const codexAuth = join(implementer.sandboxEnv.HOME as string, '.codex', 'auth.json');
        expect(existsSync(codexAuth)).toBe(true);

        await handle.acquire({ role: 'planner', config: apiPlanner });

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
        });

        const implementer = await handle.acquire({
          role: 'implementer',
          config: SAME_TOOL_SPLIT_CHANNELS,
        });
        const codexAuth = join(implementer.sandboxEnv.HOME as string, '.codex', 'auth.json');
        expect(existsSync(codexAuth)).toBe(true);

        const planner = await handle.acquire({
          role: 'planner',
          config: SAME_TOOL_SPLIT_CHANNELS,
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
        });

        const planner = await handle.acquire({
          role: 'planner',
          config: SAME_TOOL_SPLIT_CHANNELS,
        });
        const implementer = await handle.acquire({
          role: 'implementer',
          config: SAME_TOOL_SPLIT_CHANNELS,
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
      // Copilot bridges its files on Linux; on macOS its token is a keychain item.
      const hostPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
      });
      const dir = createTempDir('isolation-two-profiles');
      const hostHome = useHostHome();
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
        });

        const codexProfile = await handle.acquire({
          role: 'implementer',
          config: withRunners(config.planner, {
            kind: 'cli',
            tool: 'codex',
            authChannel: 'session',
          }),
        });
        const copilotProfile = await handle.acquire({
          role: 'implementer',
          config: withRunners(config.planner, {
            kind: 'cli',
            tool: 'copilot',
            authChannel: 'session',
          }),
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

  it('keeps the worktree and branch after all work is promoted', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-retain-accepted');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      mkdirSync(join(ws.projectDir, 'src'), { recursive: true });
      writeFileSync(join(ws.projectDir, 'src', 'app.ts'), 'export const app = true;\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');

      await handle.dispose();

      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(false);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
      expect(existsSync(isolationRoot(dir))).toBe(true);
      expect((await createGitClient(dir).branch()).all).toContain(`splitbrief/${SLUG}`);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('keeps the workspace when the checkout log changes during the run', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-live-log');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      // An untracked file the operator appends to for the whole run — the
      // run's own event log in the incident this guards against.
      writeFileSync(join(dir, 'run.ndjson'), 'line1\n');
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      // Task work, promoted: identical content in worktree and project.
      writeFileSync(join(ws.projectDir, 'a.txt'), 'A\n');
      writeFileSync(join(dir, 'a.txt'), 'A\n');
      // The project-side log grew after the worktree was seeded.
      writeFileSync(join(dir, 'run.ndjson'), 'line1\nline2\n');

      await handle.dispose();

      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(false);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
      expect((await createGitClient(dir).branch()).all).toContain(`splitbrief/${SLUG}`);
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
        warningPublisher,
      });

      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'a.txt'), 'A\n');
      writeFileSync(join(dir, 'a.txt'), 'A\n');
      writeFileSync(join(dir, 'run.ndjson'), 'line1\nline2\n');

      await handle.dispose();

      const stderrText = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText).not.toContain('uncommitted file');
      expect(warningPublisher).not.toHaveBeenCalled();
      expect(existsSync(isolationWorktree(dir))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      cleanupTempDir(dir);
    }
  });

  it('dispose leaves a workspace with a live session without removal warnings', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-publisher-wiring');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const warningPublisher = vi.fn();
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
        warningPublisher,
      });

      const ws = await acquireDirect(handle);
      const liveSessionId = 'live-isolation-session';
      const liveSessionDir = join(ws.projectDir, SPLITBRIEF_DIR, SESSIONS_DIR, liveSessionId);
      mkdirSync(liveSessionDir, { recursive: true });
      writeFileSync(join(liveSessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));

      await handle.dispose();

      expect(warningPublisher).not.toHaveBeenCalled();
      const stderrText = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText).not.toContain('live session');
      expect(existsSync(isolationWorktree(dir))).toBe(true);
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
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'notes.txt'), 'rewritten by the run\n');

      await handle.dispose();

      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(false);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it.each([
    {
      change: 'retargets a seeded project symlink',
      apply: (worktree: string) => {
        const link = join(worktree, '.claude', 'skills', 'current');
        rmSync(link);
        symlinkSync('../../skills/b', link, 'dir');
      },
    },
    {
      change: 'deletes a seeded project symlink',
      apply: (worktree: string) => rmSync(join(worktree, '.claude', 'skills', 'current')),
    },
    {
      change: 'adds a symlink that leaves the project',
      apply: (worktree: string) =>
        symlinkSync(dirname(worktree), join(worktree, 'escaping'), 'dir'),
    },
  ])(
    'retains the worktree whose worker $change, with no failed scan',
    {
      timeout: 60_000,
    },
    async ({ apply }) => {
      const dir = createTempDir('isolation-link-unpromoted');
      try {
        createTestGitRepo(dir, { 'skills/a/SKILL.md': '# a\n', 'skills/b/SKILL.md': '# b\n' });
        mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
        symlinkSync('../../skills/a', join(dir, '.claude', 'skills', 'current'), 'dir');
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
        });

        const ws = await acquireDirect(handle);
        apply(ws.projectDir);
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          await handle.dispose();
          expect(stderrSpy.mock.calls.map((call) => String(call[0]))).toEqual([]);
        } finally {
          stderrSpy.mockRestore();
        }

        expect(
          (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
        ).toBe(false);
        expect(readlinkSync(join(dir, '.claude', 'skills', 'current'))).toBe('../../skills/a');
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it('retains the worktree and branch when unpromoted work remains, reporting it', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-retain-unpromoted');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      const roleRoot = join(ws.projectDir, SANDBOX_DIR, 'implementer', 'codex');
      const npmCache = join(roleRoot, 'npm-cache');
      mkdirSync(npmCache, { recursive: true });
      writeFileSync(join(npmCache, 'cached-package.tgz'), 'cached\n');
      writeFileSync(join(ws.projectDir, 'unpromoted.txt'), 'work\n');
      await ws.retain?.();

      await handle.dispose();

      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(true);
      expect(existsSync(join(npmCache, 'cached-package.tgz'))).toBe(true);
      expect(existsSync(npmCache)).toBe(true);
      expect(existsSync(join(ws.projectDir, 'unpromoted.txt'))).toBe(true);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
      expect((await createGitClient(dir).branch()).all).toContain(`splitbrief/${SLUG}`);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('discards a gate-denied task from the worktree, keeping the run workspace', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-gate-denied');
    try {
      createTestGitRepo(dir, { 'package.json': '{}\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      writeFileSync(join(ws.projectDir, 'package.json'), '{"denied":true}\n');
      writeFileSync(join(ws.projectDir, '.env.local'), 'EXTRA=1\n');

      const task = makeTask({ id: 'T001', suggestedFiles: ['src/main.ts'] });
      const outcome = await gateAttemptChanges({
        wctx: makeWctx({
          projectDir: dir,
          sessionId: SESSION_ID,
          isolation: handle,
          callbacks: makeCallbacks({
            onTieredApproval: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'test' }),
          }).callbacks,
          config: makeNoValidationConfig({
            approval: {
              feedRejectionsToPlanner: false,
            },
          }),
        }),
        task,
        phase: 'implementing',
        workspace: ws,
        preApprovedFiles: [],
        dependsOnFiles: [],
        onApproved: () => {},
      });
      expect(outcome.outcome).toBe('denied');

      // The next acquisition observes the worktree the denial left behind.
      const next = await acquireDirect(handle);
      expect(readFileSync(join(next.projectDir, 'package.json'), 'utf8')).toBe('{}\n');
      expect(existsSync(join(next.projectDir, '.env.local'))).toBe(false);

      await handle.dispose();

      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(false);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('puts a seeded project symlink back on the attempt cleanup', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-link-conflict-fresh');
    try {
      createTestGitRepo(dir, { 'skills/a/SKILL.md': '# a\n', 'skills/b/SKILL.md': '# b\n' });
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      symlinkSync('../../skills/a', join(dir, '.claude', 'skills', 'current'), 'dir');
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      const link = join(ws.projectDir, '.claude', 'skills', 'current');
      rmSync(link);
      symlinkSync('../../skills/b', link, 'dir');
      expect(readlinkSync(join(dir, '.claude', 'skills', 'current'))).toBe('../../skills/a');

      ws.cleanup();
      const next = await handle.acquire({
        role: 'implementer',
        config,
      });
      expect(readlinkSync(join(next.projectDir, '.claude', 'skills', 'current'))).toBe(
        '../../skills/a',
      );
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  function expectCleanSources(root: string): void {
    expect(lstatSync(join(root, 'src', 'alias.ts'), { throwIfNoEntry: false })).toBe(undefined);
    expect(lstatSync(join(root, 'src', 'app.ts')).isFile()).toBe(true);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe('export const app = true;\n');
  }

  it('keeps worker symlinks of a discarded attempt out of the checkout and out of the next attempt', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-worker-links');
    try {
      createTestGitRepo(dir, {
        'src/app.ts': 'export const app = true;\n',
        'src/other.ts': 'export const other = true;\n',
      });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });

      const ws = await acquireDirect(handle);
      // The worker adds a link where nothing was, and puts a link where a file was.
      symlinkSync('app.ts', join(ws.projectDir, 'src', 'alias.ts'));
      rmSync(join(ws.projectDir, 'src', 'app.ts'));
      symlinkSync('other.ts', join(ws.projectDir, 'src', 'app.ts'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expectCleanSources(dir);

        ws.cleanup();
        const next = await handle.acquire({
          role: 'implementer',
          config,
        });
        expectCleanSources(next.projectDir);
        await handle.dispose();
        expect(stderrSpy.mock.calls.map((call) => String(call[0]))).toEqual([]);
      } finally {
        stderrSpy.mockRestore();
      }

      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(false);
      expect(existsSync(isolationWorktree(dir))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('captures kept run work as attempt input and leaves a checkout edit outside it', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-kept-edit');
    try {
      createTestGitRepo(dir, { 'docs/guide.md': 'v1\n' });
      mkdirSync(join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID), { recursive: true });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });
      const cut = await handle.acquire({
        role: 'implementer',
        config,
      });
      writeFileSync(join(cut.projectDir, 'docs', 'guide.md'), 'worker\n');
      // The run stops with the worker's edit unpromoted, and the operator edits
      // the same file before the run comes back.
      await handle.dispose();
      writeFileSync(join(dir, 'docs', 'guide.md'), 'operator\n');

      const nextHandle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });
      const next = await nextHandle.acquire({
        role: 'implementer',
        config,
      });
      expect(readFileSync(join(next.projectDir, 'docs', 'guide.md'), 'utf8')).toBe('worker\n');
      expect(await getChangedFilesSinceSnapshot(next.projectDir, next.snapshot)).toEqual([]);
      expect(readFileSync(join(dir, 'docs', 'guide.md'), 'utf8')).toBe('operator\n');
      await nextHandle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix(
    'captures a prior replacement of a project symlink as attempt input',
    {
      timeout: 60_000,
    },
    async () => {
      const dir = createTempDir('isolation-kept-link');
      try {
        createTestGitRepo(dir, { 'real.md': 'real\n' });
        symlinkSync('real.md', join(dir, 'alias.md'));
        execFileSync('git', ['add', 'alias.md'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'alias'], { cwd: dir, stdio: 'pipe' });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
        });

        const first = await acquireDirect(handle);
        rmSync(join(first.projectDir, 'alias.md'));
        writeFileSync(join(first.projectDir, 'alias.md'), 'worker\n');
        const second = await acquireDirect(handle);
        expect(await getChangedFilesSinceSnapshot(second.projectDir, second.snapshot)).toEqual([]);
        writeFileSync(join(second.projectDir, 'alias.md'), 'attempt\n');

        second.cleanup();
        const third = await acquireDirect(handle);
        expect(readFileSync(join(third.projectDir, 'alias.md'), 'utf8')).toBe('worker\n');
        await handle.dispose();
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'captures a prior replacement of an absolute symlink as attempt input',
    {
      timeout: 60_000,
    },
    async () => {
      const dir = createTempDir('isolation-kept-abs-link');
      try {
        createTestGitRepo(dir, { 'README.md': '# test\n' });
        symlinkSync('/etc/hosts', join(dir, 'alias.md'));
        execFileSync('git', ['add', 'alias.md'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'alias'], { cwd: dir, stdio: 'pipe' });
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
        });

        const first = await acquireDirect(handle);
        rmSync(join(first.projectDir, 'alias.md'));
        writeFileSync(join(first.projectDir, 'alias.md'), 'worker\n');
        const second = await acquireDirect(handle);
        expect(await getChangedFilesSinceSnapshot(second.projectDir, second.snapshot)).toEqual([]);
        await handle.dispose();
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

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
      });

      const first = await acquireDirect(handle);
      writeFileSync(join(first.projectDir, 'a.txt'), 'A\n');
      // What promotion does to the real project once the gate allows the task.
      writeFileSync(join(dir, 'a.txt'), 'A\n');

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
        const handle = createRunIsolation({
          projectDir: dir,
          sessionId: SESSION_ID,
          strategy: 'worktree',
          onFallback: () => {},
        });

        const ws = await acquireDirect(handle);
        expect(ws.projectDir).not.toBe(dir);
        expect(existsSync(isolationWorktree(dir))).toBe(true);

        await handle.dispose();

        expect(
          (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
        ).toBe(false);
        const usesWorktree = ws.projectDir === isolationWorktree(dir);
        expect(existsSync(isolationWorktree(dir))).toBe(usesWorktree);
        const branches = await createGitClient(dir).branch();
        expect(branches.all.filter((branch) => branch.startsWith('splitbrief/'))).toHaveLength(
          usesWorktree ? 1 : 0,
        );
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
      });
      const ws = await acquireDirect(handle);

      expect(lstatSync(join(ws.projectDir, 'node_modules')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(ws.projectDir, 'node_modules'))).toBe(join(dir, 'node_modules'));
      expect(ws.sandboxEnv.PATH?.split(delimiter)[0]).toBe(
        realpathSync(join(dir, 'node_modules', '.bin')),
      );
      expect(await getChangedFilesSinceSnapshot(ws.projectDir, ws.snapshot)).toEqual([]);
      writeFileSync(join(ws.projectDir, 'earlier.txt'), 'earlier task\n');
      const second = await acquireDirect(handle);
      expect(second.projectDir).toBe(ws.projectDir);
      expect(readFileSync(join(second.projectDir, 'earlier.txt'), 'utf8')).toBe('earlier task\n');
      expect(readlinkSync(join(second.projectDir, 'node_modules'))).toBe(join(dir, 'node_modules'));
      expect(second.sandboxEnv.PATH?.split(delimiter)[0]).toBe(
        realpathSync(join(dir, 'node_modules', '.bin')),
      );
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
      });

      const ws = await acquireDirect(handle);

      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/node_modules/);
      expect(ws.projectDir).not.toBe(dir);
      expect(existsSync(join(ws.projectDir, 'init.txt'))).toBe(true);
      writeFileSync(join(ws.projectDir, 'earlier.txt'), 'earlier task\n');
      const second = await acquireDirect(handle);
      expect(second.projectDir).toBe(ws.projectDir);
      expect(readFileSync(join(second.projectDir, 'earlier.txt'), 'utf8')).toBe('earlier task\n');
      expect(reasons).toHaveLength(1);
      expect(
        readdirSync(sessionDir(dir, SESSION_ID)).filter((entry) => entry.startsWith('stage-')),
      ).toHaveLength(1);
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('one workspace per run', () => {
  function worktreeRun(dir: string, onFallback: (reason: string) => void = () => {}) {
    return createRunIsolation({
      projectDir: dir,
      sessionId: SESSION_ID,
      strategy: 'worktree',
      onFallback,
    });
  }

  const acquire = (handle: ReturnType<typeof createRunIsolation>) =>
    handle.acquire({ role: 'implementer', config });

  it('acquire twice in one run returns the same workspace', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-same');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = worktreeRun(dir);

      const opened = await handle.open({ config });
      const first = await acquire(handle);
      const second = await acquire(handle);

      expect(opened.kind).toBe('worktree');
      expect(opened.projectDir).toBe(isolationWorktree(dir));
      expect(opened.head).toBe(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
      );
      expect(first.projectDir).toBe(opened.projectDir);
      expect(second.projectDir).toBe(opened.projectDir);
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('a checkout edit does not reach the workspace', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-checkout-edit');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', 'src.txt': 'v1\n' });
      const handle = worktreeRun(dir);

      const first = await acquire(handle);
      writeFileSync(join(dir, 'src.txt'), 'operator edit\n');
      writeFileSync(join(dir, 'operator.txt'), 'new\n');
      const second = await acquire(handle);

      expect(readFileSync(join(second.projectDir, 'src.txt'), 'utf8')).toBe('v1\n');
      expect(existsSync(join(second.projectDir, 'operator.txt'))).toBe(false);
      expect(await getChangedFilesSinceSnapshot(first.projectDir, first.snapshot)).toEqual([]);
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("a retry keeps earlier tasks' changes", { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-keeps-earlier');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', 'src.txt': 'v1\n' });
      const handle = worktreeRun(dir);

      const firstTask = await acquire(handle);
      writeFileSync(join(firstTask.projectDir, 'src.txt'), 'task one\n');
      writeFileSync(join(firstTask.projectDir, 'one.txt'), 'one\n');
      const retry = await acquire(handle);

      expect(readFileSync(join(retry.projectDir, 'src.txt'), 'utf8')).toBe('task one\n');
      expect(readFileSync(join(retry.projectDir, 'one.txt'), 'utf8')).toBe('one\n');
      expect(await getChangedFilesSinceSnapshot(retry.projectDir, retry.snapshot)).toEqual([]);
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('rollback reverts only the current attempt', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-rollback');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', 'src.txt': 'v1\n' });
      const handle = worktreeRun(dir);

      const earlier = await acquire(handle);
      writeFileSync(join(earlier.projectDir, 'src.txt'), 'earlier\n');
      writeFileSync(join(earlier.projectDir, 'earlier.txt'), 'kept\n');
      const attempt = await acquire(handle);
      writeFileSync(join(attempt.projectDir, 'src.txt'), 'v1\n');
      writeFileSync(join(attempt.projectDir, 'attempt.txt'), 'gone\n');
      attempt.cleanup();
      const next = await acquire(handle);

      expect(readFileSync(join(next.projectDir, 'src.txt'), 'utf8')).toBe('earlier\n');
      expect(readFileSync(join(next.projectDir, 'earlier.txt'), 'utf8')).toBe('kept\n');
      expect(existsSync(join(next.projectDir, 'attempt.txt'))).toBe(false);
      expect(readFileSync(join(dir, 'src.txt'), 'utf8')).toBe('v1\n');
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("dispose keeps an open run's worktree", { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-dispose-keeps');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const handle = worktreeRun(dir);

      const ws = await acquire(handle);
      expect(await getChangedFilesSinceSnapshot(ws.projectDir, ws.snapshot)).toEqual([]);
      await handle.dispose();

      expect(existsSync(isolationWorktree(dir))).toBe(true);
      expect(readFileSync(join(isolationWorktree(dir), 'README.md'), 'utf8')).toBe('# test\n');
      const branches = execFileSync('git', ['branch', '--list'], { cwd: dir, encoding: 'utf8' });
      expect(branches).toContain(SLUG);

      const continued = worktreeRun(dir);
      const reopened = await continued.open({ config });
      expect(reopened.projectDir).toBe(ws.projectDir);
      expect(readFileSync(join(reopened.projectDir, 'README.md'), 'utf8')).toBe('# test\n');
      await continued.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('staged copy is created once per run', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-staged-once');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', 'src.txt': 'v1\n' });
      const handle = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'staged-copy',
        onFallback: () => {},
      });

      const opened = await handle.open({ config });
      const first = await acquire(handle);
      writeFileSync(join(first.projectDir, 'src.txt'), 'task one\n');
      const second = await acquire(handle);
      writeFileSync(join(second.projectDir, 'retry.txt'), 'retry\n');
      second.cleanup();
      const third = await acquire(handle);

      expect(opened.kind).toBe('staged-copy');
      expect(opened.head).toBeNull();
      expect(new Set([first.projectDir, second.projectDir, third.projectDir])).toEqual(
        new Set([opened.projectDir]),
      );
      expect(readFileSync(join(third.projectDir, 'src.txt'), 'utf8')).toBe('task one\n');
      expect(existsSync(join(third.projectDir, 'retry.txt'))).toBe(false);
      const stages = readdirSync(join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID)).filter(
        (entry) => entry.startsWith('stage-'),
      );
      expect(stages).toHaveLength(1);
      expect(existsSync(isolationRoot(dir))).toBe(false);
      await handle.dispose();
      expect(existsSync(opened.projectDir)).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('a repository without commits falls back to one staged copy', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-run-no-commit');
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, 'src.txt'), 'v1\n');
      const reasons: string[] = [];
      const handle = worktreeRun(dir, (reason) => reasons.push(reason));

      const opened = await handle.open({ config });
      const first = await acquire(handle);
      const second = await acquire(handle);

      expect(reasons).toEqual(['repository has no commits']);
      expect(opened.kind).toBe('staged-copy');
      expect(first.projectDir).toBe(opened.projectDir);
      expect(second.projectDir).toBe(opened.projectDir);
      expect(readFileSync(join(opened.projectDir, 'src.txt'), 'utf8')).toBe('v1\n');
      await handle.dispose();
    } finally {
      removeTempDir(dir);
    }
  });

  it('no-git project falls back to one staged copy', { timeout: 60_000 }, async () => {
    const dir = createTempDir('isolation-run-no-git');
    try {
      writeFileSync(join(dir, 'src.txt'), 'v1\n');
      const reasons: string[] = [];
      const handle = worktreeRun(dir, (reason) => reasons.push(reason));

      const opened = await handle.open({ config });
      const first = await acquire(handle);
      const second = await acquire(handle);

      expect(reasons).toEqual(['project is not a git repository']);
      expect(opened.kind).toBe('staged-copy');
      expect(first.projectDir).toBe(opened.projectDir);
      expect(second.projectDir).toBe(opened.projectDir);
      expect(readFileSync(join(opened.projectDir, 'src.txt'), 'utf8')).toBe('v1\n');
      await handle.dispose();
    } finally {
      removeTempDir(dir);
    }
  });

  it('removeRunWorkspace removes a kept worktree and its branch, or a staged copy root', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-run-remove');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const worktree = worktreeRun(dir);
      const kept = await worktree.open({ config });
      await worktree.dispose();

      await removeRunWorkspace(dir, SESSION_ID, { kind: 'worktree', path: kept.projectDir });

      expect(existsSync(kept.projectDir)).toBe(false);
      expect(
        execFileSync('git', ['branch', '--list'], { cwd: dir, encoding: 'utf8' }),
      ).not.toContain(SLUG);

      const staged = createRunIsolation({
        projectDir: dir,
        sessionId: `${SESSION_ID}-staged`,
        strategy: 'staged-copy',
        onFallback: () => {},
      });
      const copy = await staged.open({ config });
      await staged.dispose();

      await removeRunWorkspace(dir, `${SESSION_ID}-staged`, {
        kind: 'staged-copy',
        path: copy.projectDir,
      });

      expect(existsSync(dirname(copy.projectDir))).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('base equals the workspace start after a checkout edit between snapshot and seed', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-run-base');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n', 'src.txt': 'v1\n' });
      const baseline = await createSnapshot({
        projectDir: dir,
        sessionId: SESSION_ID,
        phase: 'manual',
        name: 'earlier-session-baseline',
      });
      writeFileSync(join(dir, 'src.txt'), 'dirty at base\n');
      writeFileSync(join(dir, 'untracked.txt'), 'at base\n');
      const base = await createSnapshot({
        projectDir: dir,
        sessionId: SESSION_ID,
        phase: 'manual',
        name: 'workspace-base',
      });
      expect(base.manifest.id).not.toBe(baseline.manifest.id);
      expect(base.isFirstSnapshot).toBe(false);
      writeFileSync(join(dir, 'src.txt'), 'edited after base\n');
      rmSync(join(dir, 'untracked.txt'));
      writeFileSync(join(dir, 'late.txt'), 'after base\n');
      const handle = worktreeRun(dir);

      const opened = await handle.open({ config });
      await reconcileWorkspaceToBase({
        projectDir: dir,
        sessionId: SESSION_ID,
        snapshotId: base.manifest.id,
        workspaceDir: opened.projectDir,
        keep: opened.keptFiles,
      });

      expect(readFileSync(join(opened.projectDir, 'src.txt'), 'utf8')).toBe('dirty at base\n');
      expect(readFileSync(join(opened.projectDir, 'untracked.txt'), 'utf8')).toBe('at base\n');
      expect(existsSync(join(opened.projectDir, 'late.txt'))).toBe(false);
      expect(readFileSync(join(dir, 'src.txt'), 'utf8')).toBe('edited after base\n');
      await handle.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('run workspace attempts', () => {
  function isolation(projectDir: string, strategy: 'worktree' | 'staged-copy') {
    return createRunIsolation({
      projectDir,
      sessionId: SESSION_ID,
      strategy,
      onFallback: () => {},
    });
  }

  it.each(['worktree', 'staged-copy'] as const)(
    'reuses %s work across processes and ignores legacy owner changes',
    { timeout: 60_000 },
    async (strategy) => {
      const dir = createTempDir('run-workspace-owner');
      try {
        createTestGitRepo(dir, { 'src.txt': 'base\n' });
        const first = isolation(dir, strategy);
        const opening = first.open({ config });
        expect(first.open({ config })).toBe(opening);
        const opened = await opening;
        const workspace = await first.acquire({ role: 'implementer', config });
        writeFileSync(join(workspace.projectDir, 'src.txt'), 'partial\n');
        await workspace.retain?.();
        await first.dispose();
        const record = await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID });
        if (record === null) throw new Error('Missing workspace record');
        record.owner = {
          taskId: 'old-task',
          contract: 'old-contract',
          attempt: 9,
          buildSeat: 'old-seat',
        };
        writeFileSync(
          join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'retained-workspace.json'),
          JSON.stringify(record),
        );
        const next = isolation(dir, strategy);
        const nextConfig: Config = {
          ...config,
          implementer: { ...config.implementer, model: 'changed-seat' },
        };
        const reopened = await next.open({ config: nextConfig });
        expect(reopened.projectDir).toBe(opened.projectDir);
        expect(reopened.keptFiles).toEqual(['src.txt']);
        const resumed = await next.acquire({
          role: 'implementer',
          config: nextConfig,
          resume: true,
        });
        expect(await getChangedFilesSinceSnapshot(resumed.projectDir, resumed.snapshot)).toEqual([
          'src.txt',
        ]);
        expect(
          (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.owner,
        ).toHaveProperty('runId', SESSION_ID);
        await next.dispose();
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it.each(['worktree', 'staged-copy'] as const)(
    'reverts only the retained cut in %s when a new attempt starts',
    { timeout: 60_000 },
    async (strategy) => {
      const dir = createTempDir('run-workspace-cut');
      try {
        createTestGitRepo(dir, { 'src.txt': 'base\n' });
        const first = isolation(dir, strategy);
        const earlier = await first.acquire({ role: 'implementer', config });
        writeFileSync(join(earlier.projectDir, 'src.txt'), 'earlier\n');
        writeFileSync(join(earlier.projectDir, 'earlier.txt'), 'kept\n');
        const cut = await first.acquire({ role: 'implementer', config });
        writeFileSync(join(cut.projectDir, 'src.txt'), 'cut\n');
        writeFileSync(join(cut.projectDir, 'cut.txt'), 'removed\n');
        await cut.retain?.();
        await first.dispose();
        writeFileSync(join(dir, 'src.txt'), 'operator\n');
        const next = isolation(dir, strategy);
        const attempt = await next.acquire({ role: 'implementer', config });
        expect(attempt.projectDir).toBe(cut.projectDir);
        expect(readFileSync(join(attempt.projectDir, 'src.txt'), 'utf8')).toBe('earlier\n');
        expect(readFileSync(join(attempt.projectDir, 'earlier.txt'), 'utf8')).toBe('kept\n');
        expect(existsSync(join(attempt.projectDir, 'cut.txt'))).toBe(false);
        expect(await getChangedFilesSinceSnapshot(attempt.projectDir, attempt.snapshot)).toEqual(
          [],
        );
        expect(readFileSync(join(dir, 'src.txt'), 'utf8')).toBe('operator\n');
        await next.dispose();
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it('keeps a worktree with more than 8 MiB of uncommitted bytes across a stop and a restart', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('run-workspace-large-dirty');
    try {
      createTestGitRepo(dir, { 'src.txt': 'base\n' });
      const large = Buffer.alloc(9 * 1024 * 1024, 'a');
      writeFileSync(join(dir, 'large.bin'), large);
      const first = isolation(dir, 'worktree');
      const cut = await first.acquire({ role: 'implementer', config });
      writeFileSync(join(cut.projectDir, 'large.bin'), Buffer.alloc(9 * 1024 * 1024, 'b'));
      writeFileSync(join(cut.projectDir, 'src.txt'), 'cut\n');
      await cut.retain?.();
      await first.dispose();
      const recordPath = join(sessionDir(dir, SESSION_ID), 'retained-workspace.json');
      expect(statSync(recordPath).size).toBeLessThan(1024 * 1024);
      expect(
        (await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID }))?.retained,
      ).toBe(true);

      const next = isolation(dir, 'worktree');
      const attempt = await next.acquire({ role: 'implementer', config });

      expect(attempt.projectDir).toBe(cut.projectDir);
      expect(readFileSync(join(attempt.projectDir, 'large.bin')).equals(large)).toBe(true);
      expect(readFileSync(join(attempt.projectDir, 'src.txt'), 'utf8')).toBe('base\n');
      expect(await getChangedFilesSinceSnapshot(attempt.projectDir, attempt.snapshot)).toEqual([]);
      await next.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it.each(['worktree', 'staged-copy'] as const)(
    'limits %s cleanup to the supplied changed files',
    { timeout: 60_000 },
    async (strategy) => {
      const dir = createTempDir('run-workspace-selected-cleanup');
      try {
        createTestGitRepo(dir, { 'src.txt': 'base\n' });
        const run = isolation(dir, strategy);
        const attempt = await run.acquire({ role: 'implementer', config });
        writeFileSync(join(attempt.projectDir, 'src.txt'), 'allowed\n');
        writeFileSync(join(attempt.projectDir, 'denied.txt'), 'denied\n');
        attempt.cleanup(['denied.txt']);
        const next = await run.acquire({ role: 'implementer', config });
        expect(readFileSync(join(next.projectDir, 'src.txt'), 'utf8')).toBe('allowed\n');
        expect(existsSync(join(next.projectDir, 'denied.txt'))).toBe(false);
        await run.dispose();
        const continued = isolation(dir, strategy);
        const reopened = await continued.acquire({ role: 'implementer', config, resume: true });
        expect(readFileSync(join(reopened.projectDir, 'src.txt'), 'utf8')).toBe('allowed\n');
        expect(await getChangedFilesSinceSnapshot(reopened.projectDir, reopened.snapshot)).toEqual(
          [],
        );
        await continued.dispose();
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it('reconciles a delta base through baseline blobs and preserves retained and ignored files', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('run-workspace-delta-base');
    try {
      createTestGitRepo(dir, {
        'same.txt': 'baseline\n',
        'cut.txt': 'base\n',
        '.gitignore': 'ignored/\n',
      });
      await createSnapshot({ projectDir: dir, sessionId: SESSION_ID, phase: 'manual' });
      writeFileSync(join(dir, 'changed.txt'), 'delta\n');
      const base = await createSnapshot({
        projectDir: dir,
        sessionId: SESSION_ID,
        phase: 'manual',
        name: 'workspace-base',
      });
      writeFileSync(join(dir, 'same.txt'), 'late\n');
      const run = isolation(dir, 'worktree');
      const attempt = await run.acquire({ role: 'implementer', config });
      writeFileSync(join(attempt.projectDir, 'cut.txt'), 'partial\n');
      writeFileSync(join(attempt.projectDir, 'added.txt'), 'late\n');
      mkdirSync(join(attempt.projectDir, 'ignored'));
      writeFileSync(join(attempt.projectDir, 'ignored', 'cache'), 'cache\n');
      await attempt.retain?.();
      await run.dispose();
      const next = isolation(dir, 'worktree');
      const opened = await next.open({ config });
      const gitignore = readFileSync(join(opened.projectDir, '.gitignore'), 'utf8');
      await reconcileWorkspaceToBase({
        projectDir: dir,
        sessionId: SESSION_ID,
        snapshotId: base.manifest.id,
        workspaceDir: opened.projectDir,
        keep: opened.keptFiles,
      });
      expect(readFileSync(join(opened.projectDir, 'same.txt'), 'utf8')).toBe('baseline\n');
      expect(readFileSync(join(opened.projectDir, 'changed.txt'), 'utf8')).toBe('delta\n');
      expect(readFileSync(join(opened.projectDir, 'cut.txt'), 'utf8')).toBe('partial\n');
      expect(readFileSync(join(opened.projectDir, 'added.txt'), 'utf8')).toBe('late\n');
      expect(readFileSync(join(opened.projectDir, 'ignored', 'cache'), 'utf8')).toBe('cache\n');
      expect(readFileSync(join(opened.projectDir, '.gitignore'), 'utf8')).toBe(gitignore);
      await next.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('the checkout mode (workflow.isolation: none)', () => {
  function checkoutRun(dir: string, warnings: string[] = []) {
    return createRunIsolation({
      projectDir: dir,
      sessionId: SESSION_ID,
      strategy: 'none',
      onFallback: () => {
        throw new Error('the checkout mode never falls back');
      },
      warningPublisher: (message) => warnings.push(message),
    });
  }

  const worktreeList = (dir: string): string =>
    execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });

  it('hands every attempt the checkout itself and creates no worktree', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-none');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const before = worktreeList(dir);
      const run = checkoutRun(dir);

      const opened = await run.open({ config });
      const attempt = await run.acquire({ role: 'implementer', config });
      writeFileSync(join(attempt.projectDir, 'live.ts'), 'export {};\n');

      expect(opened).toMatchObject({ kind: 'checkout', projectDir: dir, keptFiles: [] });
      expect(opened.head).toBe(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
      );
      expect(attempt.projectDir).toBe(dir);
      expect(attempt.targetBaseline).toBeUndefined();
      expect(await attempt.changedFiles()).toEqual(['live.ts']);
      expect(worktreeList(dir)).toBe(before);
      expect(await readWorkspaceRecord({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
      await run.dispose();
      expect(readFileSync(join(dir, 'live.ts'), 'utf8')).toBe('export {};\n');
      expect(worktreeList(dir)).toBe(before);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('puts a failed attempt back in the checkout and saves the bytes it replaced', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-none-revert');
    try {
      createTestGitRepo(dir, { 'src/a.ts': 'export const a = 1;\n' });
      const warnings: string[] = [];
      const run = checkoutRun(dir, warnings);
      const attempt = await run.acquire({ role: 'implementer', config });
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');

      await attempt.revert(['src/a.ts']);

      expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      const reverted = join(sessionDir(dir, SESSION_ID), 'reverted');
      const [stamp] = readdirSync(reverted);
      expect(readFileSync(join(reverted, stamp ?? '', 'src', 'a.ts'), 'utf8')).toBe(
        'export const a = 2;\n',
      );
      expect(warnings).toEqual([expect.stringContaining('.splitbrief/sessions/')]);
      await run.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('works in a project with no git at all, and puts an attempt back without git', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-none-nogit');
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.ts'), 'one\n');
      const run = checkoutRun(dir);
      const opened = await run.open({ config });
      const attempt = await run.acquire({ role: 'implementer', config });
      writeFileSync(join(dir, 'src', 'a.ts'), 'two\n');
      writeFileSync(join(dir, 'src', 'b.ts'), 'new\n');

      expect(opened).toMatchObject({ kind: 'checkout', projectDir: dir, head: null });
      expect(await attempt.changedFiles()).toEqual(['src/a.ts', 'src/b.ts']);
      await attempt.revert(['src/a.ts', 'src/b.ts']);

      expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe('one\n');
      expect(existsSync(join(dir, 'src', 'b.ts'))).toBe(false);
      await run.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('keeps a recorded worktree run on its worktree after the config moves to none', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-none-recorded');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const first = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });
      const opened = await first.open({ config });
      await first.dispose();

      const next = checkoutRun(dir);
      const reopened = await next.open({ config, recorded: 'worktree' });

      expect(reopened).toMatchObject({ kind: 'worktree', projectDir: opened.projectDir });
      await next.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('keeps a recorded checkout run in the checkout after the config moves to worktree', {
    timeout: 60_000,
  }, async () => {
    const dir = createTempDir('isolation-none-recorded-checkout');
    try {
      createTestGitRepo(dir, { 'README.md': '# test\n' });
      const before = worktreeList(dir);
      const first = checkoutRun(dir);
      await first.open({ config });
      await first.dispose();

      const next = createRunIsolation({
        projectDir: dir,
        sessionId: SESSION_ID,
        strategy: 'worktree',
        onFallback: () => {},
      });
      const reopened = await next.open({ config, recorded: 'checkout' });

      expect(reopened).toMatchObject({ kind: 'checkout', projectDir: dir });
      expect(worktreeList(dir)).toBe(before);
      await next.dispose();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
