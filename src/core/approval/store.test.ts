import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  readApprovalsStore,
  writeApprovalsStore,
  clearGrantsByScope,
  mutateApprovalsStore,
} from './store.js';
import type { ApprovalsStore, ApprovalGrant } from '../schemas/approval-store.js';
import { DIPTYCH_DIR } from '../paths.js';

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
    const diptychDir = join(tmpDir, DIPTYCH_DIR);
    mkdirSync(diptychDir, { recursive: true });
    writeFileSync(join(diptychDir, 'approvals.json'), '{not valid json', 'utf-8');
    expect(() => readApprovalsStore(tmpDir)).toThrow(/approval store is corrupt/);
  });

  it('returns parsed store when file is valid', () => {
    const store: ApprovalsStore = {
      version: 1,
      grants: [makeGrant({ scope: 'always', sessionId: undefined })],
    };
    const diptychDir = join(tmpDir, DIPTYCH_DIR);
    mkdirSync(diptychDir, { recursive: true });
    writeFileSync(join(diptychDir, 'approvals.json'), JSON.stringify(store), 'utf-8');
    const result = readApprovalsStore(tmpDir);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.scope).toBe('always');
  });
});

describe('writeApprovalsStore', () => {
  it('creates file with secure mode 0o600', () => {
    const store: ApprovalsStore = { version: 1, grants: [] };
    writeApprovalsStore(tmpDir, store);
    const diptychDir = join(tmpDir, DIPTYCH_DIR);
    const stats = statSync(join(diptychDir, 'approvals.json'));
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

    const files = readdirSync(join(tmpDir, DIPTYCH_DIR));
    expect(files.some((file) => file.endsWith('.lock'))).toBe(false);
  });

  it('serializes read-modify-write so interleaved appends never lose a grant', () => {
    for (let i = 0; i < 25; i++) {
      mutateApprovalsStore(tmpDir, (store) => ({
        version: 1,
        grants: [...store.grants, makeGrant({ pattern: `cmd-${i}` })],
      }));
    }

    const patterns = readApprovalsStore(tmpDir).grants.map((g) => g.pattern);
    expect(patterns).toHaveLength(25);
    expect(new Set(patterns).size).toBe(25);
  });
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
