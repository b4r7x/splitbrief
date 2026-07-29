import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readApprovalsStore,
  writeApprovalsStore,
  clearGrantsByScope,
  mutateApprovalsStore,
} from './store.js';
import type { ApprovalsStore, ApprovalGrant } from '../schemas/approval-store.js';
import { SPLITBRIEF_DIR, approvalsFile } from '../paths.js';
import { lockSibling } from '../../lib/file-lock.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const ACTOR_A = join(REPO_ROOT, 'testing/fixtures/approval-store-contention/actor-a.mjs');
const ACTOR_B = join(REPO_ROOT, 'testing/fixtures/approval-store-contention/actor-b.mjs');

function waitForPath(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function spawnActor(script: string, projectDir: string, syncDir: string) {
  return spawn(TSX, [script, projectDir, syncDir], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child timed out')), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`child exited with ${code}`));
    });
  });
}

let tmpDir: string;

const makeGrant = (overrides: Partial<ApprovalGrant> = {}): ApprovalGrant => ({
  pattern: 'npm install',
  class: 'package_change',
  scope: 'session',
  sessionId: 'sess-1',
  grantedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'approvals-store-test-'));
});

describe('readApprovalsStore', () => {
  it('returns empty store when file is absent', () => {
    const result = readApprovalsStore(tmpDir);
    expect(result).toEqual({ version: 1, grants: [] });
  });

  it('throws when file contains corrupted JSON', () => {
    const splitbriefDir = join(tmpDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });
    writeFileSync(join(splitbriefDir, 'approvals.json'), '{not valid json', 'utf-8');
    expect(() => readApprovalsStore(tmpDir)).toThrow(/approval store is corrupt/);
  });

  it('returns parsed store when file is valid', () => {
    const store: ApprovalsStore = {
      version: 1,
      grants: [makeGrant({ scope: 'always', sessionId: undefined })],
    };
    const splitbriefDir = join(tmpDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });
    writeFileSync(join(splitbriefDir, 'approvals.json'), JSON.stringify(store), 'utf-8');
    const result = readApprovalsStore(tmpDir);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe('always');
  });
});

describe('writeApprovalsStore', () => {
  it('creates file with secure mode 0o600', () => {
    const store: ApprovalsStore = { version: 1, grants: [] };
    writeApprovalsStore(tmpDir, store);
    const splitbriefDir = join(tmpDir, SPLITBRIEF_DIR);
    const stats = statSync(join(splitbriefDir, 'approvals.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('round-trips data correctly', () => {
    const store: ApprovalsStore = {
      version: 1,
      grants: [makeGrant({ scope: 'always', sessionId: undefined })],
    };
    writeApprovalsStore(tmpDir, store);
    const result = readApprovalsStore(tmpDir);
    expect(result).toEqual(store);
  });
});

describe('mutateApprovalsStore', () => {
  it('reads the current store, applies the transform, and persists the result', () => {
    writeApprovalsStore(tmpDir, { version: 1, grants: [makeGrant({ pattern: 'a' })] });

    const result = mutateApprovalsStore(tmpDir, (store) => ({
      version: 1,
      grants: [...store.grants, makeGrant({ pattern: 'b' })],
    }));

    expect(result.grants.map((g) => g.pattern)).toEqual(['a', 'b']);
    expect(readApprovalsStore(tmpDir).grants.map((g) => g.pattern)).toEqual(['a', 'b']);
  });

  it('leaves the store untouched when the transform returns null', () => {
    writeApprovalsStore(tmpDir, { version: 1, grants: [makeGrant({ pattern: 'a' })] });

    const result = mutateApprovalsStore(tmpDir, () => null);

    expect(result.grants.map((g) => g.pattern)).toEqual(['a']);
    expect(readApprovalsStore(tmpDir).grants.map((g) => g.pattern)).toEqual(['a']);
  });

  it('does not leave a lock file behind after a successful mutation', () => {
    mutateApprovalsStore(tmpDir, () => ({ version: 1, grants: [makeGrant()] }));

    const files = readdirSync(join(tmpDir, SPLITBRIEF_DIR));
    expect(files.some((file) => file.endsWith('.lock'))).toBe(false);
  });

  it('serializes read-modify-write so interleaved appends never lose a grant', async () => {
    const syncDir = join(tmpDir, 'sync');
    mkdirSync(syncDir, { recursive: true });
    mkdirSync(join(tmpDir, SPLITBRIEF_DIR), { recursive: true });

    const lockPath = lockSibling(approvalsFile(tmpDir));
    const childA = spawnActor(ACTOR_A, tmpDir, syncDir);
    waitForPath(join(syncDir, 'a-entered'), 5000);
    waitForPath(lockPath, 5000);

    const childB = spawnActor(ACTOR_B, tmpDir, syncDir);
    waitForPath(join(syncDir, 'b-starting'), 5000);
    writeFileSync(join(syncDir, 'release-a'), '');

    await Promise.all([waitForExit(childA, 5000), waitForExit(childB, 5000)]);

    const patterns = readApprovalsStore(tmpDir)
      .grants.map((g) => g.pattern)
      .sort();
    expect(patterns).toEqual(['a', 'b']);
    expect(readdirSync(join(tmpDir, SPLITBRIEF_DIR)).some((file) => file.endsWith('.lock'))).toBe(
      false,
    );
  }, 30_000);
});

describe('clearGrantsByScope', () => {
  const sessionGrant = makeGrant({ scope: 'session', sessionId: 'sess-1' });
  const alwaysGrant = makeGrant({ pattern: 'rm -rf', scope: 'always', sessionId: undefined });
  const store: ApprovalsStore = { version: 1, grants: [sessionGrant, alwaysGrant] };

  it('removes only session grants when scope is session', () => {
    const result = clearGrantsByScope(store, 'session');
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe('always');
  });

  it('removes only always grants when scope is always', () => {
    const result = clearGrantsByScope(store, 'always');
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe('session');
  });

  it('removes all grants when scope is all', () => {
    const result = clearGrantsByScope(store, 'all');
    expect(result.grants).toHaveLength(0);
  });

  it('does not mutate original store', () => {
    clearGrantsByScope(store, 'all');
    expect(store.grants).toHaveLength(2);
  });

  it('preserves version field', () => {
    const result = clearGrantsByScope(store, 'all');
    expect(result.version).toBe(1);
  });
});
