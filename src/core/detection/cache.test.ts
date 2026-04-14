import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDetectionCache, saveDetectionCache, invalidateCache } from './cache.js';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('detection cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'diptych-cache-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const planners = [
    { tool: 'claude-code' as const, type: 'cli' as const, available: true, description: 'Claude Code CLI' },
  ];
  const implementers = [
    { provider: 'ollama' as const, available: true, isLocal: true, models: [{ id: 'qwen2.5-coder:7b' }] },
  ];

  it('returns null when no cache exists', async () => {
    const result = await loadDetectionCache(tempDir);
    expect(result).toBeNull();
  });

  it('saves and loads cache', async () => {
    await saveDetectionCache(tempDir, planners, implementers);
    const result = await loadDetectionCache(tempDir);
    expect(result).toEqual({ planners, implementers });
  });

  it('returns null when cache is expired (TTL=0)', async () => {
    await saveDetectionCache(tempDir, planners, implementers);
    const result = await loadDetectionCache(tempDir, 0);
    expect(result).toBeNull();
  });

  it('returns data when cache is within TTL', async () => {
    await saveDetectionCache(tempDir, planners, implementers);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).not.toBeNull();
  });

  it('returns null for corrupted JSON', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'detection-cache.json'), 'not valid json', 'utf-8');
    const result = await loadDetectionCache(tempDir);
    expect(result).toBeNull();
  });

  it('returns null for valid JSON with wrong schema', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify({ foo: 'bar' }), 'utf-8');
    const result = await loadDetectionCache(tempDir);
    expect(result).toBeNull();
  });

  it('returns null for cache with wrong version', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const oldCache = { version: 0, timestamp: Date.now(), planners, implementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(oldCache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('returns null for cache without version field', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const legacyCache = { timestamp: Date.now(), planners, implementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(legacyCache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('returns null when a planner entry is missing required fields', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const badPlanners = [{ description: 'no tool or type field' }];
    const cache = { version: 1, timestamp: Date.now(), planners: badPlanners, implementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(cache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('returns null when a planner entry has an invalid tool value', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const badPlanners = [{ tool: 'unknown-tool', type: 'cli', available: true }];
    const cache = { version: 1, timestamp: Date.now(), planners: badPlanners, implementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(cache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('returns null when an implementer entry is missing required fields', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const badImplementers = [{ available: true }];
    const cache = { version: 1, timestamp: Date.now(), planners, implementers: badImplementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(cache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('returns null when an implementer has a malformed model entry', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const badImplementers = [
      { provider: 'ollama', available: true, isLocal: true, models: [{ notId: 123 }] },
    ];
    const cache = { version: 1, timestamp: Date.now(), planners, implementers: badImplementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(cache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('returns null when available field has wrong type', async () => {
    const dir = join(tempDir, '.diptych');
    await mkdir(dir, { recursive: true });
    const badPlanners = [{ tool: 'claude-code', type: 'cli', available: 'yes' }];
    const cache = { version: 1, timestamp: Date.now(), planners: badPlanners, implementers };
    await writeFile(join(dir, 'detection-cache.json'), JSON.stringify(cache), 'utf-8');
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toBeNull();
  });

  it('roundtrips empty arrays', async () => {
    await saveDetectionCache(tempDir, [], []);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toEqual({ planners: [], implementers: [] });
  });

  it('includes version in saved cache', async () => {
    await saveDetectionCache(tempDir, planners, implementers);
    const raw = await readFile(join(tempDir, '.diptych', 'detection-cache.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
  });

  it('does not throw when save target is read-only', async () => {
    await expect(saveDetectionCache('/nonexistent/readonly/path', planners, implementers))
      .resolves.toBeUndefined();
  });

  describe('invalidateCache', () => {
    it('removes existing cache file', async () => {
      await saveDetectionCache(tempDir, planners, implementers);
      const before = await loadDetectionCache(tempDir, 60_000);
      expect(before).not.toBeNull();

      await invalidateCache(tempDir);
      const after = await loadDetectionCache(tempDir, 60_000);
      expect(after).toBeNull();
    });

    it('does not throw when no cache exists', async () => {
      await expect(invalidateCache(tempDir)).resolves.toBeUndefined();
    });
  });
});
