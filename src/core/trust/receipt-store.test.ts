import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { readTrustStore, resolveTrustStorePath, trustedProjectIdentity } from './receipt-store.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let directories: string[] = [];

function tempDir(prefix: string): string {
  const dir = createTempDir(prefix);
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories) cleanupTempDir(dir);
  directories = [];
});

const parseAny = (value: unknown): unknown => value;

describe('resolveTrustStorePath', () => {
  it('roots receipts in the owner home, never in the project', () => {
    const trustHome = useTrustHome('receipt-store-home');
    try {
      const projectDir = tempDir('receipt-store-project');
      const path = resolveTrustStorePath('hooks.json');
      expect(path).toBe(join(trustHome.home, '.splitbrief', 'trust', 'hooks.json'));
      expect(path.startsWith(projectDir)).toBe(false);
    } finally {
      trustHome.restore();
    }
  });

  it('honours an explicit state directory for callers that scope their own store', () => {
    const stateDir = tempDir('receipt-store-state');
    expect(resolveTrustStorePath('custom-runners.json', stateDir)).toBe(
      join(stateDir, 'custom-runners.json'),
    );
  });
});

describe('trustedProjectIdentity', () => {
  it('is stable per checkout and different for a different checkout', () => {
    const first = tempDir('receipt-store-identity-a');
    const second = tempDir('receipt-store-identity-b');
    const identity = trustedProjectIdentity(first);

    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trustedProjectIdentity(first)).toBe(identity);
    expect(trustedProjectIdentity(second)).not.toBe(identity);
  });

  itUnix('canonicalizes, so a symlinked path is the same checkout', () => {
    const projectDir = tempDir('receipt-store-identity-real');
    const linkParent = tempDir('receipt-store-identity-link');
    const linked = join(linkParent, 'project-link');
    symlinkSync(projectDir, linked, 'dir');

    expect(trustedProjectIdentity(linked)).toBe(trustedProjectIdentity(projectDir));
  });

  it('fails closed when the path cannot be canonicalized', () => {
    expect(trustedProjectIdentity(join(tempDir('receipt-store-gone'), 'absent'))).toBeNull();
  });
});

describe('readTrustStore', () => {
  it('reports a missing store apart from an unusable one', () => {
    const stateDir = tempDir('receipt-store-missing');
    expect(readTrustStore(join(stateDir, 'hooks.json'), parseAny)).toEqual({ kind: 'missing' });
  });

  it('returns the parsed value for an owner-only store', () => {
    const stateDir = tempDir('receipt-store-valid');
    const path = join(stateDir, 'hooks.json');
    writeFileSync(path, '{"version":1,"receipts":[]}', { mode: 0o600 });

    expect(readTrustStore(path, parseAny)).toEqual({
      kind: 'value',
      value: { version: 1, receipts: [] },
    });
  });

  it('rejects a store whose contents the caller will not vouch for', () => {
    const stateDir = tempDir('receipt-store-rejected');
    const path = join(stateDir, 'hooks.json');
    writeFileSync(path, '{"version":1,"receipts":[]}', { mode: 0o600 });

    expect(readTrustStore(path, () => null)).toEqual({ kind: 'invalid' });
  });

  it('rejects malformed JSON', () => {
    const stateDir = tempDir('receipt-store-malformed');
    const path = join(stateDir, 'hooks.json');
    writeFileSync(path, 'not json', { mode: 0o600 });

    expect(readTrustStore(path, parseAny)).toEqual({ kind: 'invalid' });
  });

  itUnix('rejects a store any other account can read', () => {
    const stateDir = tempDir('receipt-store-permissive');
    const path = join(stateDir, 'hooks.json');
    writeFileSync(path, '{"version":1,"receipts":[]}', { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(readTrustStore(path, parseAny)).toEqual({ kind: 'invalid' });
  });

  itUnix('refuses to follow a symlink standing in for the store', () => {
    const stateDir = tempDir('receipt-store-symlink');
    const target = join(stateDir, 'real.json');
    writeFileSync(target, '{"version":1,"receipts":[]}', { mode: 0o600 });
    symlinkSync(target, join(stateDir, 'hooks.json'));

    expect(readTrustStore(join(stateDir, 'hooks.json'), parseAny)).toEqual({ kind: 'invalid' });
  });

  it('rejects a directory in place of the store', () => {
    const stateDir = tempDir('receipt-store-directory');
    mkdirSync(join(stateDir, 'hooks.json'));

    expect(readTrustStore(join(stateDir, 'hooks.json'), parseAny)).toEqual({ kind: 'invalid' });
  });

  it('rejects a store larger than a receipt ledger can legitimately be', () => {
    const stateDir = tempDir('receipt-store-oversized');
    const path = join(stateDir, 'hooks.json');
    writeFileSync(path, `{"padding":"${'x'.repeat(256 * 1024)}"}`, { mode: 0o600 });

    expect(readTrustStore(path, parseAny)).toEqual({ kind: 'invalid' });
  });
});
