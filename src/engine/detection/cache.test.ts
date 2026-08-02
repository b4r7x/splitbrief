import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDetectionCache, saveDetectionCache, invalidateCache } from './cache.js';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('detection cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-cache-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const cliTools: CliToolDetection[] = [cliDetectionFor('ready', 'claude-code')];
  const providers: ProviderDetection[] = [
    {
      provider: 'ollama',
      available: true,
      isLocal: true,
      models: [{ id: 'qwen2.5-coder:7b' }],
    },
  ];

  it('returns null when no cache exists', async () => {
    const result = await loadDetectionCache(tempDir);
    expect(result).toBeNull();
  });

  it('roundtrips the complete detection payload', async () => {
    const cliTools: CliToolDetection[] = [
      cliDetectionFor('incompatible', 'codex', {
        executable: {
          path: join(tmpdir(), 'codex'),
          fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        },
        installedVersion: '9.0.0',
      }),
    ];
    const providers: ProviderDetection[] = [
      {
        provider: 'ollama',
        available: false,
        isLocal: true,
        error: 'connection refused',
      },
      {
        provider: 'openrouter',
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
            pricingTiers: [
              {
                type: 'context',
                thresholdTokens: 0,
                inputPer1M: 3,
                outputPer1M: 15,
                cacheReadPer1M: 0.3,
                cacheWritePer1M: 3.75,
              },
              {
                type: 'context',
                thresholdTokens: 200_000,
                inputPer1M: 6,
                outputPer1M: 22.5,
                cacheReadPer1M: 0.6,
                cacheWritePer1M: 7.5,
              },
            ],
            pricingProvenance: {
              asOf: '2026-07-31',
              source: 'test fixture pricing record',
            },
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
    await saveDetectionCache(tempDir, providers, cliTools);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toEqual({ providers, cliTools });

    const loadedTier = result?.providers[1]?.models?.[0]?.pricingTiers?.[0];
    if (!loadedTier) throw new Error('Expected cached pricing tier');
    loadedTier.inputPer1M = 99;
    expect(providers[1]?.models?.[0]?.pricingTiers?.[0]?.inputPer1M).toBe(3);
  });

  it('returns null when cache is expired (TTL=0)', async () => {
    await saveDetectionCache(tempDir, providers, cliTools);
    const result = await loadDetectionCache(tempDir, 0);
    expect(result).toBeNull();
  });

  it('returns data when cache is within TTL', async () => {
    await saveDetectionCache(tempDir, providers, cliTools);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).not.toBeNull();
  });

  it('returns null for corrupted JSON', async () => {
    const dir = join(tempDir, '.splitbrief');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'detection-cache.json'), 'not valid json', 'utf-8');
    const result = await loadDetectionCache(tempDir);
    expect(result).toBeNull();
  });

  it('roundtrips empty arrays', async () => {
    await saveDetectionCache(tempDir, [], []);
    const result = await loadDetectionCache(tempDir, 60_000);
    expect(result).toEqual({ providers: [], cliTools: [] });
  });

  itUnix('returns null when .splitbrief is a symlink outside the project', async () => {
    const projectDir = createTempDir('cache-symlink-splitbrief');
    const outside = createTempDir('cache-symlink-outside');
    try {
      mkdirSync(join(outside, 'nested'), { recursive: true });
      writeFileSync(
        join(outside, 'detection-cache.json'),
        JSON.stringify({
          version: 2,
          timestamp: Date.now(),
          providers,
          cliTools,
        }),
      );
      symlinkSync(outside, join(projectDir, SPLITBRIEF_DIR));

      await expect(loadDetectionCache(projectDir, 60_000)).resolves.toBeNull();
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(projectDir);
    }
  });

  it('includes version in saved cache', async () => {
    await saveDetectionCache(tempDir, providers, cliTools);
    const raw = await readFile(join(tempDir, '.splitbrief', 'detection-cache.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(2);
  });

  it('rejects version 1 cache data', async () => {
    const dir = join(tempDir, '.splitbrief');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'detection-cache.json'),
      JSON.stringify({ version: 1, timestamp: Date.now(), providers, cliTools }),
      'utf-8',
    );

    await expect(loadDetectionCache(tempDir, 60_000)).resolves.toBeNull();
  });

  it('rejects planner and implementer field aliases', async () => {
    const dir = join(tempDir, '.splitbrief');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'detection-cache.json'),
      JSON.stringify({ version: 2, timestamp: Date.now(), planners: [], implementers: [] }),
      'utf-8',
    );

    await expect(loadDetectionCache(tempDir, 60_000)).resolves.toBeNull();
  });

  it('does not throw when save target is read-only', async () => {
    await expect(
      saveDetectionCache('/nonexistent/readonly/path', providers, cliTools),
    ).resolves.toBeUndefined();
  });

  describe('invalidateCache', () => {
    it('removes existing cache file', async () => {
      await saveDetectionCache(tempDir, providers, cliTools);
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
