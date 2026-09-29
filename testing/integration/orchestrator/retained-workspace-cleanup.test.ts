import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { sessionDir } from '../../../src/core/paths.js';
import { createRunIsolation } from '../../../src/engine/orchestrator/isolation/create.js';
import {
  readWorkspaceRecord,
  workspaceOwner,
} from '../../../src/engine/orchestrator/isolation/retention.js';
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
  const owner = workspaceOwner({ task: makeTask({ file: 'partial.ts' }), attempt: 1, config });
  const notices: Array<{ path: string; purpose: string | undefined }> = [];
  const warnings: string[] = [];
  const ref = { projectDir, sessionId };
  const makeIsolation = () =>
    createRunIsolation({
      ...ref,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: (path, purpose) => notices.push({ path, purpose }),
      warningPublisher: (message) => warnings.push(message),
    });
  const options = {
    role: 'implementer' as const,
    config,
    writesFiles: 'direct' as const,
    owner,
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
    receipt: join(sessionDir(projectDir, sessionId), `preserved-${record.location.leaf}.json`),
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

// The retired writer published the receipt with a temp-file rename. The current
// writer creates the final leaf exclusively and writes every byte through the
// descriptor returned by that open, so the substitution races arm themselves on
// these boundaries. Every race case asserts the boundary was actually reached.
function interceptFirstReceiptBoundary(action: () => void): () => boolean {
  let intercepted = false;
  const fire = (): void => {
    if (intercepted) return;
    intercepted = true;
    action();
  };
  const open = syncFs.openSync;
  const fsync = syncFs.fsyncSync;
  vi.spyOn(syncFs, 'openSync').mockImplementation((...args) => {
    fire();
    return open(...args);
  });
  vi.spyOn(syncFs, 'fsyncSync').mockImplementation((...args) => {
    fire();
    return fsync(...args);
  });
  return () => intercepted;
}

// The receipt completion boundary: every byte is written and fsynced, while the
// canonical record has not been cleared yet.
function interceptReceiptCompletion(receipt: string, action: () => void): () => boolean {
  let intercepted = false;
  const receiptFds = new Set<number>();
  const open = syncFs.openSync;
  const fsync = syncFs.fsyncSync;
  vi.spyOn(syncFs, 'openSync').mockImplementation((...args) => {
    const fd = open(...args);
    if (args[0] === receipt) receiptFds.add(fd);
    return fd;
  });
  vi.spyOn(syncFs, 'fsyncSync').mockImplementation((fd) => {
    if (!intercepted && receiptFds.has(fd)) {
      intercepted = true;
      action();
    }
    fsync(fd);
  });
  return () => intercepted;
}

function substituteReceiptParent(sessionRoot: string, foreign: string): void {
  syncFs.renameSync(sessionRoot, `${sessionRoot}-owned`);
  syncFs.mkdirSync(foreign, { recursive: true });
  syncFs.symlinkSync(foreign, sessionRoot, 'dir');
}

function restoreReceiptParent(sessionRoot: string): void {
  syncFs.unlinkSync(sessionRoot);
  syncFs.renameSync(`${sessionRoot}-owned`, sessionRoot);
}

it.each(['root', 'leaf'] as const)(
  'preserves foreign cache and bridged bytes after %s substitution during disposal checks',
  async (part) => {
    for (const kind of ['symlink', 'directory'] as const) {
      const f = await fixture();
      let swapped = false;
      let verify: (() => void) | undefined;
      const original = fs.lstat;
      const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        const observed = await original(...args);
        if (!swapped && args[0] === dirname(f.workspace.projectDir)) {
          swapped = true;
          verify = replaceWorkspace(f, part, kind);
        }
        return observed;
      });
      await f.run.dispose();
      expect(swapped).toBe(true);
      expect(verify).toBeDefined();
      verify?.();
      spy.mockRestore();
    }
  },
);

it('keeps the complete stopped sandbox without reporting a cleanup failure', async () => {
  const f = await fixture();
  const verify = sentinels(f.workspace.projectDir);
  await f.run.dispose();
  verify();
  expect(f.warnings).toEqual([]);
  expect(f.notices).toEqual([{ path: f.workspace.projectDir, purpose: 'continuation' }]);
  expect(syncFs.existsSync(f.receipt)).toBe(false);
  expect((await readWorkspaceRecord(f.ref))?.retained).toBe(true);
});

it.each(['root', 'leaf'] as const)(
  'archives a replaced %s without deleting it when another owner acquires',
  async (part) => {
    const f = await fixture();
    const verify = replaceWorkspace(f, part, 'directory');
    const next = f.makeIsolation();
    const acquired = await next.acquire({
      ...f.options,
      owner: { ...f.options.owner, attempt: 2 },
    });
    expect(acquired.projectDir).not.toBe(f.workspace.projectDir);
    expect(syncFs.existsSync(join(acquired.projectDir, 'partial.ts'))).toBe(false);
    acquired.cleanup();
    await next.dispose();
    verify();
    expect(syncFs.statSync(f.receipt).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(syncFs.readFileSync(f.receipt, 'utf8'));
    expect(receipt.disposition).toBe('manual-removal');
    expect(Object.keys(receipt).sort()).toEqual([
      'directory',
      'disposition',
      'location',
      'version',
    ]);
    expect(syncFs.statSync(f.receipt).size).toBeLessThan(4096);
    expect(await readWorkspaceRecord(f.ref)).toBeNull();
  },
);

it.each(['root', 'leaf'] as const)(
  'keeps foreign bytes when %s replacement occurs during resumed retirement',
  async (part) => {
    const f = await fixture();
    const next = f.makeIsolation();
    const acquired = await next.acquire(f.options);
    let verify: (() => void) | undefined;
    const intercepted = interceptReceiptCompletion(f.receipt, () => {
      verify = replaceWorkspace(f, part, 'directory');
    });
    acquired.cleanup();
    await next.dispose();
    expect(intercepted()).toBe(true);
    expect(verify).toBeDefined();
    verify?.();
    expect(await readWorkspaceRecord(f.ref)).toBeNull();
    await expect(acquired.retain?.()).rejects.toThrow('automatic continuation is blocked');
    expect(await readWorkspaceRecord(f.ref)).toBeNull();
  },
);

it('keeps a foreign receipt sentinel when the receipt parent is swapped', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  const sessionRoot = dirname(f.receipt);
  const foreign = join(f.parent, 'foreign-receipt');
  const sentinel = join(foreign, basename(f.receipt));
  const sentinelBytes = 'foreign receipt sentinel';
  syncFs.mkdirSync(foreign, { recursive: true });
  syncFs.writeFileSync(sentinel, sentinelBytes);
  const canonical = syncFs.readFileSync(f.canonical);
  const intercepted = interceptFirstReceiptBoundary(() =>
    substituteReceiptParent(sessionRoot, foreign),
  );
  let refused = false;
  try {
    acquired.cleanup();
  } catch {
    refused = true;
  }
  expect(intercepted()).toBe(true);
  expect(syncFs.readFileSync(sentinel, 'utf8')).toBe(sentinelBytes);
  expect(refused).toBe(true);
  restoreReceiptParent(sessionRoot);
  expect(syncFs.existsSync(f.receipt)).toBe(false);
  expect(syncFs.readFileSync(f.canonical)).toEqual(canonical);
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  await next.dispose();
  expect(syncFs.readFileSync(f.receipt, 'utf8')).toContain('manual-removal');
  expect(syncFs.readFileSync(f.canonical).toString()).toBe('null\n');
  expect(syncFs.readFileSync(sentinel, 'utf8')).toBe(sentinelBytes);
});

it('leaves only an empty residual leaf when the receipt parent is swapped', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  const sessionRoot = dirname(f.receipt);
  const foreign = join(f.parent, 'foreign-residue');
  syncFs.mkdirSync(foreign, { recursive: true });
  const canonical = syncFs.readFileSync(f.canonical);
  const intercepted = interceptFirstReceiptBoundary(() =>
    substituteReceiptParent(sessionRoot, foreign),
  );
  let refused = false;
  try {
    acquired.cleanup();
  } catch {
    refused = true;
  }
  expect(intercepted()).toBe(true);
  const residual = join(foreign, basename(f.receipt));
  expect(syncFs.statSync(residual).size).toBe(0);
  expect(syncFs.readFileSync(residual, 'utf8')).toBe('');
  expect(refused).toBe(true);
  restoreReceiptParent(sessionRoot);
  expect(syncFs.existsSync(f.receipt)).toBe(false);
  expect(syncFs.readFileSync(f.canonical)).toEqual(canonical);
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  await next.dispose();
  expect(syncFs.readFileSync(f.receipt, 'utf8')).toContain('manual-removal');
  expect(syncFs.readFileSync(f.canonical).toString()).toBe('null\n');
  expect(syncFs.statSync(residual).size).toBe(0);
});

it.each(['resumed cleanup', 'changed owner'] as const)(
  'keeps canonical ownership when the retirement receipt fails during %s',
  async (operation) => {
    const f = await fixture();
    const next = f.makeIsolation();
    const acquired = operation === 'resumed cleanup' ? await next.acquire(f.options) : undefined;
    syncFs.mkdirSync(f.receipt);
    const previous = syncFs.readFileSync(f.canonical);
    if (acquired !== undefined) {
      expect(() => acquired.cleanup()).toThrow();
      // Disposal retries the pending retirement and reports the remaining failure.
      await expect(next.dispose()).rejects.toThrow('continuation record could not be saved');
    } else {
      await expect(
        next.acquire({ ...f.options, owner: { ...f.options.owner, attempt: 2 } }),
      ).rejects.toThrow();
      await next.dispose();
    }
    expect(syncFs.readFileSync(f.canonical)).toEqual(previous);
    expect(syncFs.readFileSync(join(f.workspace.projectDir, 'partial.ts'), 'utf8')).toBe(
      'owned partial',
    );
  },
);

it('accepts an exact published receipt through its descriptor on retry', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  syncFs.rmSync(f.canonical);
  syncFs.mkdirSync(f.canonical);
  let refused = false;
  try {
    acquired.cleanup();
  } catch {
    refused = true;
  }
  const receipt = syncFs.readFileSync(f.receipt);
  expect(JSON.parse(receipt.toString('utf8')).disposition).toBe('manual-removal');
  expect(refused).toBe(true);
  syncFs.rmdirSync(f.canonical);
  expect(() => acquired.cleanup()).not.toThrow();
  expect(syncFs.readFileSync(f.receipt)).toEqual(receipt);
  expect(syncFs.readFileSync(f.canonical).toString()).toBe('null\n');
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  await next.dispose();
  expect(await readWorkspaceRecord(f.ref)).toBeNull();
});

it('retries a pending retirement after the obstructed receipt path is cleared', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  const canonical = syncFs.readFileSync(f.canonical);
  syncFs.mkdirSync(f.receipt);
  let refused = false;
  try {
    acquired.cleanup();
  } catch {
    refused = true;
  }
  expect(syncFs.statSync(f.receipt).isDirectory()).toBe(true);
  expect(syncFs.readFileSync(f.canonical)).toEqual(canonical);
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  expect(refused).toBe(true);
  syncFs.rmdirSync(f.receipt);
  expect(() => acquired.cleanup()).not.toThrow();
  const receipt = JSON.parse(syncFs.readFileSync(f.receipt, 'utf8'));
  expect(receipt.disposition).toBe('manual-removal');
  expect(syncFs.readFileSync(f.canonical).toString()).toBe('null\n');
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  await next.dispose();
  expect(await readWorkspaceRecord(f.ref)).toBeNull();
});

it('retires resumed output without granting later continuation permission', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  acquired.cleanup();
  await next.dispose();
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  expect(syncFs.existsSync(f.receipt)).toBe(true);
  expect(await readWorkspaceRecord(f.ref)).toBeNull();
  const following = f.makeIsolation();
  const fresh = await following.acquire(f.options);
  expect(fresh.projectDir).not.toBe(acquired.projectDir);
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
  const fresh = await next.acquire({ ...f.options, fresh: true });
  const current = syncFs.readFileSync(f.canonical);
  old.cleanup();
  await expect(old.retain?.()).rejects.toThrow('automatic continuation is blocked');
  expect(syncFs.readFileSync(f.canonical)).toEqual(current);
  fresh.cleanup();
  await next.dispose();
});

it('rejects a disposed retirement handle without rewriting the cleared record', async () => {
  const f = await fixture();
  const next = f.makeIsolation();
  const acquired = await next.acquire(f.options);
  acquired.cleanup();
  await next.dispose();
  const cleared = syncFs.readFileSync(f.canonical);
  expect(cleared.toString()).toBe('null\n');
  await expect(acquired.retain?.()).rejects.toThrow('automatic continuation is blocked');
  acquired.cleanup();
  expect(syncFs.readFileSync(f.canonical)).toEqual(cleared);
  expect(syncFs.readFileSync(join(acquired.projectDir, 'partial.ts'), 'utf8')).toBe(
    'owned partial',
  );
  const following = f.makeIsolation();
  const fresh = await following.acquire(f.options);
  expect(fresh.projectDir).not.toBe(acquired.projectDir);
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
  await expect(following.acquire(f.options)).rejects.toThrow('automatic continuation is blocked');
  await following.dispose();
});
