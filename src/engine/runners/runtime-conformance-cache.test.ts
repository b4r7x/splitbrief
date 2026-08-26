import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readRuntimeConformance,
  hasRuntimeConformance,
  recordRuntimeConformance,
} from './runtime-conformance-cache.js';
import { RUNTIME_CONFORMANCE_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';

describe('runtime-conformance-cache', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'splitbrief-conformance-'));
  });

  afterEach(() => {
    try {
      chmodSync(join(testDir, SPLITBRIEF_DIR), 0o700);
    } catch {}
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reports no recorded conformance before the first run', () => {
    const cache = readRuntimeConformance(testDir);
    expect(cache).toBeNull();
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.235' })).toBe(
      false,
    );
  });

  it('records the version after a successful generation', () => {
    recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' });

    const cache = readRuntimeConformance(testDir);
    expect(cache).not.toBeNull();
    expect(cache?.version).toBe(1);
    expect(cache?.entries).toHaveLength(1);
    expect(cache?.entries[0]).toMatchObject({
      backend: 'claude-code',
      version: '2.1.235',
      recordedAt: expect.any(Number),
    });
  });

  it('matches only the exact backend and version pair', () => {
    recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' });

    const cache = readRuntimeConformance(testDir);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.235' })).toBe(true);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.232' })).toBe(
      false,
    );
    expect(hasRuntimeConformance(cache, { backend: 'opencode', version: '2.1.235' })).toBe(false);
    expect(hasRuntimeConformance(null, { backend: 'claude-code', version: '2.1.235' })).toBe(false);
  });

  it('corrupt cache file behaves as empty', () => {
    const splitbriefDir = join(testDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });

    writeFileSync(join(splitbriefDir, RUNTIME_CONFORMANCE_FILE), '{ not valid json');
    expect(readRuntimeConformance(testDir)).toBeNull();

    writeFileSync(
      join(splitbriefDir, RUNTIME_CONFORMANCE_FILE),
      JSON.stringify({ version: 999, entries: [] }),
    );
    expect(readRuntimeConformance(testDir)).toBeNull();
  });

  it('updates existing entries for the same backend and runtime version', () => {
    recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' });
    recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' });

    expect(readRuntimeConformance(testDir)?.entries).toHaveLength(1);
  });

  it('handles multiple backends and versions', () => {
    recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' });
    recordRuntimeConformance(testDir, { backend: 'opencode', version: '1.18.15' });

    const cache = readRuntimeConformance(testDir);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.235' })).toBe(true);
    expect(hasRuntimeConformance(cache, { backend: 'opencode', version: '1.18.15' })).toBe(true);
    expect(cache?.entries).toHaveLength(2);
  });

  it('evicts the oldest entry once the cap is reached', () => {
    for (let i = 0; i <= 100; i++) {
      recordRuntimeConformance(testDir, { backend: 'claude-code', version: `2.1.${i}` });
    }

    const cache = readRuntimeConformance(testDir);
    expect(cache?.entries).toHaveLength(100);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.0' })).toBe(false);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.1' })).toBe(true);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.100' })).toBe(true);
  });

  it('refuses to record a version string beyond the bound', () => {
    recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' });

    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      recordRuntimeConformance(testDir, { backend: 'claude-code', version: 'x'.repeat(129) });
    } finally {
      warn.mockRestore();
    }

    const cache = readRuntimeConformance(testDir);
    expect(cache?.entries).toHaveLength(1);
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.235' })).toBe(true);
  });

  it('handles unwritable directory gracefully without throwing', () => {
    const splitbriefDir = join(testDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });
    chmodSync(splitbriefDir, 0o400);

    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(() =>
        recordRuntimeConformance(testDir, { backend: 'claude-code', version: '2.1.235' }),
      ).not.toThrow();
    } finally {
      warn.mockRestore();
    }

    const cache = readRuntimeConformance(testDir);
    expect(cache).toBeNull();
    expect(hasRuntimeConformance(cache, { backend: 'claude-code', version: '2.1.235' })).toBe(
      false,
    );
  });
});
