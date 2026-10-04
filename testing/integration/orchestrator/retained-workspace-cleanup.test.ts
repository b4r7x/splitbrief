import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { sessionDir } from '../../../src/core/paths.js';
import { createRunIsolation } from '../../../src/engine/orchestrator/isolation/create.js';
import { readWorkspaceRecord } from '../../../src/engine/orchestrator/isolation/retention.js';
import { sandboxRoot } from '../../../src/engine/runners/sandbox-state-paths.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) syncFs.rmSync(root, { recursive: true, force: true });
});

async function fixture(input: { cli?: boolean } = {}) {
  const parent = syncFs.mkdtempSync(join(tmpdir(), 'preserved-workspace-'));
  roots.push(parent);
  const projectDir = join(parent, 'project');
  syncFs.mkdirSync(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  const sessionId = 'preserved';
  ensureSessionDir(projectDir, sessionId);
  const config = makeNoValidationConfig(
    input.cli === true
      ? { implementer: { kind: 'cli', tool: 'codex', authChannel: 'api-key' } }
      : undefined,
  );
  const notices: string[] = [];
  const warnings: string[] = [];
  const ref = { projectDir, sessionId };
  const makeIsolation = () =>
    createRunIsolation({
      ...ref,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: (path) => notices.push(path),
      warningPublisher: (message) => warnings.push(message),
    });
  const options = {
    role: 'implementer' as const,
    config,
    resume: true,
  };
  const run = makeIsolation();
  const workspace = await run.acquire(options);
  syncFs.writeFileSync(join(workspace.projectDir, 'partial.ts'), 'owned partial');
  await workspace.retain?.();
  const record = await readWorkspaceRecord(ref);
  if (record?.location.kind !== 'staged-copy') throw new Error('Missing staged record');
  return {
    parent,
    ref,
    run,
    workspace,
    options,
    makeIsolation,
    notices,
    warnings,
    canonical: join(sessionDir(projectDir, sessionId), 'retained-workspace.json'),
  };
}

function sentinels(workspace: string) {
  const root = sandboxRoot(workspace, 'implementer');
  const files = [join(root, 'npm-cache/foreign-cache'), join(root, 'home/.codex/auth.json')];
  for (const file of files) {
    syncFs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    syncFs.writeFileSync(file, 'foreign bytes', { mode: 0o400 });
  }
  return () => {
    for (const file of files) expect(syncFs.readFileSync(file, 'utf8')).toBe('foreign bytes');
  };
}

function replaceWorkspace(
  f: Awaited<ReturnType<typeof fixture>>,
  part: 'root' | 'leaf',
  kind: 'symlink' | 'directory',
) {
  const replaced = part === 'root' ? dirname(f.workspace.projectDir) : f.workspace.projectDir;
  syncFs.renameSync(replaced, `${replaced}-owned`);
  const foreign = kind === 'directory' ? replaced : join(f.parent, 'foreign');
  syncFs.mkdirSync(foreign);
  if (kind === 'symlink') syncFs.symlinkSync(foreign, replaced, 'dir');
  return sentinels(part === 'root' ? join(foreign, 'workspace') : foreign);
}

it.each(['root', 'leaf'] as const)(
  'preserves foreign cache and bridged bytes after %s substitution during disposal',
  async (part) => {
    for (const kind of ['symlink', 'directory'] as const) {
      const f = await fixture();
      const verify = replaceWorkspace(f, part, kind);
      await f.run.dispose();
      verify();
    }
  },
);

it('keeps the complete stopped sandbox without reporting a cleanup failure', async () => {
  const f = await fixture();
  const verify = sentinels(f.workspace.projectDir);
  await f.run.dispose();
  verify();
  expect(f.warnings).toEqual([]);
  expect(f.notices).toEqual([f.workspace.projectDir]);
  expect((await readWorkspaceRecord(f.ref))?.retained).toBe(true);
});

it.each(['root', 'leaf'] as const)(
  'refuses a replaced %s without deleting it on acquisition',
  async (part) => {
    const f = await fixture();
    const verify = replaceWorkspace(f, part, 'directory');
    const next = f.makeIsolation();
    await expect(next.acquire(f.options)).rejects.toThrow('automatic continuation is blocked');
    await next.dispose();
    verify();
    expect((await readWorkspaceRecord(f.ref))?.retained).toBe(true);
  },
);

it('reverts resumed attempt output and keeps the run record', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  acquired.cleanup();
  await next.dispose();
  expect(syncFs.existsSync(join(acquired.projectDir, 'partial.ts'))).toBe(false);
  expect((await readWorkspaceRecord(f.ref))?.retained).toBe(false);
  const following = f.makeIsolation();
  const fresh = await following.acquire(f.options);
  expect(fresh.projectDir).toBe(acquired.projectDir);
  expect(syncFs.existsSync(join(fresh.projectDir, 'partial.ts'))).toBe(false);
  fresh.cleanup();
  await following.dispose();
});

it('refuses substituted CLI reacquisition before refreshing foreign bridge files', async () => {
  const f = await fixture({ cli: true });
  const root = dirname(f.workspace.projectDir);
  const foreign = join(f.parent, 'foreign');
  const bridgeFile = join(sandboxRoot(foreign, 'implementer', 'codex'), 'home/.codex/auth.json');
  syncFs.mkdirSync(dirname(bridgeFile), { recursive: true });
  syncFs.writeFileSync(bridgeFile, 'foreign bridge');
  let swapped = false;
  const original = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const observed = await original(...args);
    if (!swapped && args[0] === root) {
      syncFs.renameSync(f.workspace.projectDir, `${f.workspace.projectDir}-owned`);
      syncFs.symlinkSync(foreign, f.workspace.projectDir, 'dir');
      swapped = true;
    }
    return observed;
  });
  const next = f.makeIsolation();
  let rejected = false;
  try {
    await next.acquire(f.options);
  } catch {
    rejected = true;
  }
  await next.dispose();
  expect(swapped).toBe(true);
  expect(syncFs.existsSync(bridgeFile)).toBe(true);
  expect(syncFs.readFileSync(bridgeFile, 'utf8')).toBe('foreign bridge');
  expect(rejected).toBe(true);
});

it('uses and removes a fresh private sandbox on each retained re-entry', async () => {
  const f = await fixture({ cli: true });
  const verify = sentinels(f.workspace.projectDir);
  await f.run.dispose();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  expect(acquired.projectDir).toBe(f.workspace.projectDir);
  const home = acquired.sandboxEnv.HOME;
  if (home === undefined) throw new Error('Missing private HOME');
  expect(home.startsWith(acquired.projectDir)).toBe(false);
  const sandboxRoot = home.slice(0, home.indexOf('/.splitbrief/'));
  expect(syncFs.statSync(sandboxRoot).mode & 0o777).toBe(0o700);
  syncFs.writeFileSync(join(home, 'entry-state'), 'private state');
  await acquired.retain?.();
  await next.dispose();
  expect(syncFs.existsSync(sandboxRoot)).toBe(false);
  verify();
  expect((await readWorkspaceRecord(f.ref))?.retained).toBe(true);
});

it('does not let stale cleanup clear a successor continuation record', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const old = await next.acquire(f.options);
  const fresh = await next.acquire({ ...f.options, resume: false });
  const current = syncFs.readFileSync(f.canonical);
  old.cleanup();
  await expect(old.retain?.()).rejects.toThrow('automatic continuation is blocked');
  expect(syncFs.readFileSync(f.canonical)).toEqual(current);
  fresh.cleanup();
  await next.dispose();
});

it('rejects a disposed handle without rewriting the run record', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  acquired.cleanup();
  await next.dispose();
  const cleared = syncFs.readFileSync(f.canonical);
  expect(JSON.parse(cleared.toString()).retained).toBe(false);
  await expect(acquired.retain?.()).rejects.toThrow('automatic continuation is blocked');
  acquired.cleanup();
  expect(syncFs.readFileSync(f.canonical)).toEqual(cleared);
  expect(syncFs.existsSync(join(acquired.projectDir, 'partial.ts'))).toBe(false);
  const following = f.makeIsolation();
  const fresh = await following.acquire(f.options);
  expect(fresh.projectDir).toBe(acquired.projectDir);
  expect(syncFs.existsSync(join(fresh.projectDir, 'partial.ts'))).toBe(false);
  fresh.cleanup();
  await following.dispose();
});

it('waits for an in-flight retain and revokes it before disposal completes', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  const canonical = syncFs.readFileSync(f.canonical);
  const order: string[] = [];
  const pending = acquired.retain?.();
  const settled = pending?.then(
    () => {
      order.push('retain');
    },
    (failure: unknown) => {
      order.push('retain');
      return failure;
    },
  );
  await next.dispose().then(() => order.push('dispose'));
  expect(order).toEqual(['retain', 'dispose']);
  const failure = await settled;
  expect(failure).toBeInstanceOf(Error);
  expect(String((failure as Error).message)).toMatch(/continuation record could not be saved/);
  expect(syncFs.readFileSync(f.canonical)).toEqual(canonical);
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  const following = f.makeIsolation();
  const continued = await following.acquire(f.options);
  expect(continued.projectDir).toBe(acquired.projectDir);
  expect(syncFs.readFileSync(join(continued.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  await following.dispose();
});
