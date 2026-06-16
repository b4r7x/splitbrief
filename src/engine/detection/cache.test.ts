import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDetectionCache, saveDetectionCache, invalidateCache } from './cache.js';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { CLI_TOOLS } from '../runners/cli-tools.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('detection cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'diptych-cache-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const planners = [
    {
      tool: 'claude-code' as const,
      type: 'cli' as const,
      available: true,
      description: 'Claude Code CLI',
    },
  ];
  const implementers = [
    {
      provider: 'ollama' as const,
      available: true,
      isLocal: true,
      models: [{ id: 'qwen2.5-coder:7b' }],
    },
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

  it('roundtrips implementer error field', async () => {
    const withError = [
      { provider: 'ollama' as const, available: false, isLocal: true, error: 'connection refused' },
    ];
    await saveDetectionCache(tempDir, planners, withError);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result?.implementers[0]).toMatchObject({ error: 'connection refused' });
  });

  it('roundtrips empty arrays', async () => {
    await saveDetectionCache(tempDir, [], []);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toEqual({ planners: [], implementers: [] });
  });

  it('roundtrips planner compatibility advisory', async () => {
    const withCompatibility = [
      {
        tool: 'codex' as const,
        type: 'cli' as const,
        available: true,
        version: '9.0.0',
        compatibility: {
          kind: 'major-version-mismatch' as const,
          installedVersion: '9.0.0',
          testedVersion: CLI_TOOLS.codex.testedVersion,
        },
      },
    ];
    await saveDetectionCache(tempDir, withCompatibility, implementers);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result?.planners[0]).toMatchObject({
      compatibility: {
        kind: 'major-version-mismatch',
        installedVersion: '9.0.0',
        testedVersion: CLI_TOOLS.codex.testedVersion,
      },
    });
  });

  it('roundtrips extended detected model fields', async () => {
    const withModelFields = [
      {
        provider: 'openrouter' as const,
        available: true,
        isLocal: false,
        models: [
          {
            id: 'anthropic/claude-3.5-sonnet',
            contextLength: 200_000,
            maxOutputTokens: 8_192,
            pricingInput: 3,
            pricingOutput: 15,
            pricingCacheRead: 0.3,
            pricingCacheWrite: 3.75,
            isFree: false,
            supportsTemperature: true,
            supportsReasoning: false,
            supportsImages: true,
            capabilities: ['tools'],
            releaseDate: '2024-06-20',
          },
        ],
      },
    ];
    await saveDetectionCache(tempDir, planners, withModelFields);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result?.implementers[0]?.models?.[0]).toEqual(withModelFields[0]!.models![0]);
  });

  itUnix('returns null when .diptych is a symlink outside the project', async () => {
    const projectDir = createTempDir('cache-symlink-diptych');
    const outside = createTempDir('cache-symlink-outside');
    try {
      mkdirSync(join(outside, 'nested'), { recursive: true });
      writeFileSync(
        join(outside, 'detection-cache.json'),
        JSON.stringify({
          version: 1,
          timestamp: Date.now(),
          planners,
          implementers,
        }),
      );
      symlinkSync(outside, join(projectDir, DIPTYCH_DIR));

      await expect(loadDetectionCache(projectDir, 60_000)).resolves.toBeNull();
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(projectDir);
    }
  });

  it('includes version in saved cache', async () => {
    await saveDetectionCache(tempDir, planners, implementers);
    const raw = await readFile(join(tempDir, '.diptych', 'detection-cache.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
  });

  it('does not throw when save target is read-only', async () => {
    await expect(
      saveDetectionCache('/nonexistent/readonly/path', planners, implementers),
    ).resolves.toBeUndefined();
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
