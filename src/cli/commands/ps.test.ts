import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { psCommand, type PsDeps } from './ps.js';
import {
  ISOLATION_TREES_DIR,
  isolationMarkerPath,
  isolationTreesRoot,
  isolationWorktreeRoot,
} from '../../core/paths.js';
import { ensureIsolationWorktree } from '../../engine/orchestrator/isolation/worktree.js';
import type { LockfileData, ServerStatus } from '../../engine/ipc/lockfile.js';
import { createGitClient } from '../../lib/git/client.js';
import { formatShellArgv } from '../../utils/shell-quote.js';

let testDir: string;
let xdgStateHome: string;
const originalPlatform = process.platform;
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const lockfiles = new Map<string, LockfileData | null>();
const statuses = new Map<string, ServerStatus>();

const fakeDeps: PsDeps = {
  readLockfile: async (sessionDir) => lockfiles.get(sessionDir) ?? null,
  checkServerStatus: async (sessionDir) => {
    return statuses.get(sessionDir) ?? { alive: false, crashed: false, data: null };
  },
};

function putSession(
  sessionId: string,
  data: LockfileData | null,
  status: ServerStatus = { alive: false, crashed: false, data },
): void {
  const sessDir = join(testDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  lockfiles.set(sessDir, data);
  statuses.set(sessDir, status);
}

function putInteractiveSession(sessionId: string, mtimeMs: number): void {
  putSession(sessionId, null);
  const statePath = join(testDir, '.splitbrief', 'sessions', sessionId, 'state.json');
  writeFileSync(statePath, JSON.stringify({ feature: `feature-${sessionId}` }));
  const seconds = mtimeMs / 1000;
  utimesSync(statePath, seconds, seconds);
}

function putCollectableSession(sessionId: string): void {
  putSession(sessionId, null);
  const sessDir = join(testDir, '.splitbrief', 'sessions', sessionId);
  writeFileSync(join(sessDir, 'readiness.json'), '{}');
  const oldSeconds = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
  utimesSync(sessDir, oldSeconds, oldSeconds);
}

const isolationRoot = (): string => isolationWorktreeRoot(realpathSync(join(testDir, '.git')));

function putIsolationWorktreeMarker(slug: string, marker: string): string {
  const wtDir = join(isolationRoot(), slug);
  mkdirSync(join(wtDir, '.splitbrief'), { recursive: true });
  writeFileSync(join(wtDir, '.git'), `gitdir: ${testDir}/.git/worktrees/${slug}`);
  writeFileSync(isolationMarkerPath(wtDir), marker);
  return wtDir;
}

const putIsolationWorktree = (slug: string, sessionId: string): string =>
  putIsolationWorktreeMarker(slug, JSON.stringify({ sessionId, projectDir: testDir }));

async function collectPsOutput(): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(line);
  });

  await psCommand({ projectDir: testDir }, fakeDeps);
  return lines;
}

async function collectPsStreams(): Promise<{ stdout: string[]; stderr: string }> {
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = await collectPsOutput();
  return { stdout, stderr: stderrSpy.mock.calls.map((call) => String(call[0])).join('') };
}

function putRunningSession(sessionId: string): void {
  const nowMs = Date.now();
  const data: LockfileData = {
    version: 1,
    pid: 100,
    startTimeMs: nowMs,
    lastAliveMs: nowMs,
    sessionId,
    mode: 'standard',
    feature: 'real feature',
  };
  putSession(sessionId, data, { alive: true, data });
}

beforeEach(() => {
  testDir = join(tmpdir(), `ps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  xdgStateHome = `${testDir}-state`;
  mkdirSync(testDir, { recursive: true });
  mkdirSync(xdgStateHome, { recursive: true });
  process.env.XDG_STATE_HOME = xdgStateHome;
  lockfiles.clear();
  statuses.clear();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

afterEach(() => {
  if (existsSync(join(testDir, '.git'))) {
    rmSync(isolationRoot(), { recursive: true, force: true });
  }
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  rmSync(xdgStateHome, { recursive: true, force: true });
  rmSync(`${testDir}-outside`, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  vi.restoreAllMocks();
});

describe('psCommand', () => {
  it('prints "No sessions found" when sessions directory does not exist', async () => {
    const lines = await collectPsOutput();

    expect(lines).toEqual([expect.stringContaining('No sessions found')]);
  });

  it('prints "No sessions found" when sessions directory is empty', async () => {
    mkdirSync(join(testDir, '.splitbrief', 'sessions'), { recursive: true });

    const lines = await collectPsOutput();

    expect(lines).toEqual([expect.stringContaining('No sessions found')]);
  });

  it('shows one row per session with correct STATUS', async () => {
    const nowMs = Date.now();
    const sessionA: LockfileData = {
      version: 1,
      pid: 111,
      startTimeMs: nowMs - 60000,
      lastAliveMs: nowMs,
      sessionId: 'session-a',
      mode: 'standard',
      feature: 'feature A',
    };
    const sessionB: LockfileData = {
      version: 1,
      pid: 222,
      startTimeMs: nowMs - 30000,
      lastAliveMs: nowMs - 35000,
      sessionId: 'session-b',
      mode: 'quick',
      feature: 'feature B',
      exitedAt: nowMs - 5000,
      exitCode: 0,
    };
    putSession('session-a', sessionA, { alive: true, data: sessionA });
    putSession('session-b', sessionB, { alive: false, crashed: false, data: sessionB });

    const lines = await collectPsOutput();

    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    expect(body.find((line) => line.includes('session-a'))).toContain('running');
    expect(body.find((line) => line.includes('session-b'))).toContain('exited');
  });

  it('sorts by startTimeMs descending', async () => {
    const nowMs = Date.now();
    const olderStart = nowMs - 120000;
    const newerStart = nowMs - 10000;
    const older: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: olderStart,
      lastAliveMs: olderStart,
      sessionId: 'a-older-session',
      mode: 'standard',
      feature: 'older feature',
      exitedAt: nowMs - 100000,
      exitCode: 0,
    };
    const newer: LockfileData = {
      version: 1,
      pid: 200,
      startTimeMs: newerStart,
      lastAliveMs: nowMs,
      sessionId: 'b-newer-session',
      mode: 'quick',
      feature: 'newer feature',
    };
    putSession('a-older-session', older, { alive: false, crashed: false, data: older });
    putSession('b-newer-session', newer, { alive: true, data: newer });

    const lines = await collectPsOutput();

    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    expect(body[0]).toContain('b-newer-session');
    expect(body[1]).toContain('a-older-session');
  });

  it('omits directories with no lockfile, no state and no summary, aliasing only real sessions', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs,
      lastAliveMs: nowMs,
      sessionId: 'aliased-session',
      mode: 'standard',
      feature: 'aliased feature',
    };
    putSession('aliased-session', data, { alive: true, data });
    putSession('empty-session', null);

    const lines = await collectPsOutput();

    expect(lines.find((line) => line.includes('aliased-session'))?.trimStart()).toMatch(/^1\s/);
    expect(lines.some((line) => line.includes('empty-session'))).toBe(false);
  });

  it('prints the no-sessions message when every directory was omitted', async () => {
    putSession('only-readiness', null);

    const lines = await collectPsOutput();

    expect(lines).toEqual([expect.stringContaining('No sessions found')]);
  });

  it('hints at the collectable count when collectable directories exist', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs,
      lastAliveMs: nowMs,
      sessionId: 'real-session',
      mode: 'standard',
      feature: 'real feature',
    };
    putSession('real-session', data, { alive: true, data });
    putCollectableSession('2026-08-01-collectable');

    const lines = await collectPsOutput();

    expect(lines).toContain(
      '1 collectable session directory exists; run "splitbrief ps --prune" to collect it.',
    );
  });

  it('agrees in number when more than one directory is collectable', async () => {
    putRunningSession('real-session');
    putCollectableSession('2026-08-01-collectable');
    putCollectableSession('2026-08-02-collectable');

    const lines = await collectPsOutput();

    expect(lines).toContain(
      '2 collectable session directories exist; run "splitbrief ps --prune" to collect them.',
    );
  });

  it('prints no hint when no directory is collectable', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs,
      lastAliveMs: nowMs,
      sessionId: 'real-session',
      mode: 'standard',
      feature: 'real feature',
    };
    putSession('real-session', data, { alive: true, data });

    const lines = await collectPsOutput();

    expect(lines.some((line) => line.includes('collectable session directory'))).toBe(false);
  });

  it('--prune removes collectable directories, reports each, and leaves session state in place', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs,
      lastAliveMs: nowMs,
      sessionId: 'real-session',
      mode: 'standard',
      feature: 'real feature',
    };
    putSession('real-session', data, { alive: true, data });
    putInteractiveSession('interactive-session', nowMs);
    putCollectableSession('2026-08-01-collectable');
    const collectableDir = join(testDir, '.splitbrief', 'sessions', '2026-08-01-collectable');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    await psCommand({ projectDir: testDir, prune: true }, fakeDeps);

    expect(existsSync(collectableDir)).toBe(false);
    expect(existsSync(join(testDir, '.splitbrief', 'sessions', 'real-session'))).toBe(true);
    expect(existsSync(join(testDir, '.splitbrief', 'sessions', 'interactive-session'))).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('Removed collectable session directory 2026-08-01-collectable.'),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes('Collected 1 orphaned session directory.'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('real-session'))).toBe(true);
    expect(lines.some((line) => line.includes('interactive-session'))).toBe(true);
  });

  it('names an isolation worktree whose session directory is gone in the hint', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs,
      lastAliveMs: nowMs,
      sessionId: 'real-session',
      mode: 'standard',
      feature: 'real feature',
    };
    putSession('real-session', data, { alive: true, data });
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    const orphanDir = putIsolationWorktree('2026-08-01-orphan', '2026-07-01-gone-session');
    putIsolationWorktree('2026-08-01-kept', 'real-session');

    const lines = await collectPsOutput();

    expect(lines.some((line) => line.includes(`Orphaned isolation worktree "${orphanDir}"`))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes(`git worktree remove ${orphanDir} --force`))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('git branch -D splitbrief/2026-08-01-orphan'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('2026-08-01-kept'))).toBe(false);
  });

  it('shell-quotes orphan cleanup commands with metacharacters in the state path and branch', async () => {
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    const stateHome = join(xdgStateHome, "state home;$(echo nope)'");
    process.env.XDG_STATE_HOME = stateHome;
    const slug = 'orphan branch;$(echo nope)';
    const orphanDir = putIsolationWorktree(slug, '2026-07-01-gone-session');

    const lines = await collectPsOutput();

    const removeCommand = formatShellArgv(['git', 'worktree', 'remove', orphanDir, '--force']);
    const deleteBranchCommand = formatShellArgv(['git', 'branch', '-D', `splitbrief/${slug}`]);
    expect(lines).toContain(
      `Orphaned isolation worktree "${orphanDir}" (session 2026-07-01-gone-session no longer exists); remove it with "${removeCommand}" then "${deleteBranchCommand}".`,
    );
  });

  it('reports a worktree run isolation actually created once its session is gone', async () => {
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    const result = await ensureIsolationWorktree({
      projectDir: testDir,
      sessionId: '2026-07-01-gone-session',
      git: createGitClient(testDir),
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;

    const lines = await collectPsOutput();

    expect(
      lines.some(
        (line) =>
          line.includes(`Orphaned isolation worktree "${result.worktreePath}"`) &&
          line.includes('session 2026-07-01-gone-session no longer exists'),
      ),
    ).toBe(true);
  });

  it('an isolation worktree whose session lives in a linked worktree of the same repo is not reported orphaned', async () => {
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    const laneDir = join(testDir, '.trees', 'lane-a');
    execFileSync('git', ['worktree', 'add', laneDir, '-b', 'lane-a'], {
      cwd: testDir,
      stdio: 'pipe',
    });
    const sessionId = '2026-08-01-lane-feature';
    const result = await ensureIsolationWorktree({
      projectDir: laneDir,
      sessionId,
      git: createGitClient(laneDir),
    });
    expect(result.kind).toBe('ready');
    mkdirSync(join(laneDir, '.splitbrief', 'sessions', sessionId), { recursive: true });

    const lines = await collectPsOutput();

    expect(lines.some((line) => line.includes('Orphaned isolation worktree'))).toBe(false);
    expect(lines.some((line) => line.includes('records no owning project'))).toBe(false);
  });

  it('lists a worktree whose marker names no owning project without removal commands', async () => {
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    const wtDir = putIsolationWorktreeMarker('2026-08-01-legacy', '2026-07-01-gone-session');

    const lines = await collectPsOutput();

    expect(
      lines.some((line) =>
        line.includes(`Isolation worktree "${wtDir}" records no owning project`),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes('git worktree remove'))).toBe(false);
    expect(lines.some((line) => line.includes('Orphaned isolation worktree'))).toBe(false);
  });

  it('still lists sessions and warns when the isolation directory cannot be read', async () => {
    putRunningSession('real-session');
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    putIsolationWorktree('2026-08-01-orphan', '2026-07-01-gone-session');
    chmodSync(isolationRoot(), 0o000);

    try {
      const { stdout, stderr } = await collectPsStreams();

      expect(stdout.some((line) => line.includes('real-session'))).toBe(true);
      expect(stdout.some((line) => line.includes('Orphaned isolation worktree'))).toBe(false);
      expect(stderr).toContain(ISOLATION_TREES_DIR);
      expect(stderr).toContain('EACCES');
    } finally {
      chmodSync(isolationRoot(), 0o755);
    }
  });

  it('refuses an isolation directory that resolves outside the isolation trees root', async () => {
    putRunningSession('real-session');
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    const outside = `${testDir}-outside`;
    const wtDir = join(outside, '2026-08-01-orphan');
    mkdirSync(join(wtDir, '.splitbrief'), { recursive: true });
    writeFileSync(join(wtDir, '.git'), `gitdir: ${outside}/.git/worktrees/2026-08-01-orphan`);
    writeFileSync(isolationMarkerPath(wtDir), '2026-07-01-gone-session');
    mkdirSync(isolationTreesRoot(), { recursive: true });
    symlinkSync(outside, isolationRoot());

    const { stdout, stderr } = await collectPsStreams();

    expect(stdout.some((line) => line.includes('real-session'))).toBe(true);
    expect(stdout.join('\n')).not.toContain('2026-08-01-orphan');
    expect(stderr).toContain('resolves outside the external isolation trees root');
  });

  it('rejects XDG_STATE_HOME=<project>/.git before probing isolation worktrees', async () => {
    putRunningSession('real-session');
    createTestGitRepo(testDir, { 'README.md': '# test\n' });
    process.env.XDG_STATE_HOME = join(testDir, '.git');

    const { stdout, stderr } = await collectPsStreams();

    expect(stdout.some((line) => line.includes('real-session'))).toBe(true);
    expect(stdout.some((line) => line.includes('Orphaned isolation worktree'))).toBe(false);
    expect(stderr).toContain(
      'Isolation worktree directory overlaps the project root or repository git root.',
    );
    expect(existsSync(isolationTreesRoot())).toBe(false);
  });

  it('aliases lockfile-less interactive sessions', async () => {
    putInteractiveSession('interactive-session', Date.now());

    const lines = await collectPsOutput();

    const body = lines.slice(1);
    expect(body).toHaveLength(1);
    expect(body[0]?.trimStart()).toMatch(/^1\s/);
    expect(body[0]).toContain('interactive-session');
  });

  it('orders a newer interactive session ahead of an older detached one', async () => {
    const nowMs = Date.now();
    const detached: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs - 600000,
      lastAliveMs: nowMs - 600000,
      sessionId: 'old-detached',
      mode: 'standard',
      feature: 'detached feature',
      exitedAt: nowMs - 500000,
      exitCode: 0,
    };
    putSession('old-detached', detached, { alive: false, crashed: false, data: detached });
    putInteractiveSession('new-interactive', nowMs);

    const lines = await collectPsOutput();

    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    expect(body[0]).toContain('new-interactive');
    expect(body[1]).toContain('old-detached');
  });

  it('ELAPSED column shows correct duration string for exited session', async () => {
    const startMs = Date.now() - 5 * 60 * 1000;
    const endMs = startMs + 2 * 60 * 1000 + 30 * 1000;
    const data: LockfileData = {
      version: 1,
      pid: 999,
      startTimeMs: startMs,
      lastAliveMs: endMs,
      sessionId: 'timed-session',
      mode: 'instant',
      feature: 'timed feature',
      exitedAt: endMs,
      exitCode: 0,
    };
    putSession('timed-session', data, { alive: false, crashed: false, data: null });

    const lines = await collectPsOutput();

    expect(lines[1]).toContain('2m 30s');
  });

  it('shows crashed status correctly', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 555,
      startTimeMs: nowMs - 300000,
      lastAliveMs: nowMs - 300000,
      sessionId: 'crashed-session',
      mode: 'speckit',
      feature: 'bad feature',
      signal: 'SIGKILL',
    };
    putSession('crashed-session', data, { alive: false, crashed: true, data });

    const lines = await collectPsOutput();

    expect(lines[1]).toContain('crashed');
  });

  it('ELAPSED column is not 0s for crashed session when lastAliveMs is after start', async () => {
    const startMs = Date.now() - 120000;
    const lastAliveMs = startMs + 90000;
    const data: LockfileData = {
      version: 1,
      pid: 777,
      startTimeMs: startMs,
      lastAliveMs,
      sessionId: 'elapsed-crashed',
      mode: 'standard',
      feature: 'elapsed feature',
      signal: 'SIGTERM',
    };
    putSession('elapsed-crashed', data, { alive: false, crashed: true, data });

    const lines = await collectPsOutput();

    expect(lines[1]).toMatch(/1m\s+\d+s/);
    expect(lines[1]).not.toMatch(/^\s*0s\s/);
    expect(lines[1]).toContain('1m');
  });

  it('strips terminal controls from session ids and skips invalid session directories', async () => {
    const startMs = Date.now();
    const safeId = '2025-04-01-safe-session';
    putSession(safeId, {
      version: 1,
      pid: 42,
      startTimeMs: startMs,
      lastAliveMs: startMs,
      sessionId: safeId,
      mode: 'standard',
      feature: 'feature',
    });
    const unsafeId = 'bad\u001b]0;pwned\u0007session';
    putSession(unsafeId, {
      version: 1,
      pid: 43,
      startTimeMs: startMs,
      lastAliveMs: startMs,
      sessionId: unsafeId,
      mode: 'standard',
      feature: 'feature',
    });
    putSession('../escape', {
      version: 1,
      pid: 44,
      startTimeMs: startMs,
      lastAliveMs: startMs,
      sessionId: '../escape',
      mode: 'standard',
      feature: 'feature',
    });

    const lines = await collectPsOutput();

    expect(lines.some((line) => line.includes(safeId))).toBe(true);
    expect(lines.join('\n')).not.toContain('\u001b');
    expect(lines.join('\n')).not.toContain('../escape');
  });

  it('throws cliError with exit code 1 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(psCommand({ projectDir: testDir }, fakeDeps)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('not supported on Windows'),
    });
  });
});
