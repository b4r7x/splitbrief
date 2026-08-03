import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { DetectionCacheSnapshot } from './cache.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import {
  invalidateCache,
  loadDetectionCache,
  loadDetectionCacheSnapshot,
  saveDetectionCache,
} from './cache.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const CACHE_CONTEXT = 'readiness-context-v1';

function cacheSnapshot(overrides: Partial<DetectionCacheSnapshot> = {}): DetectionCacheSnapshot {
  return {
    contextKey: CACHE_CONTEXT,
    fetchedAt: 1_786_000_000_000,
    validatedAt: 1_786_000_001_000,
    generation: 12,
    requestId: 27,
    providers: [],
    cliTools: [],
    ...overrides,
  };
}

function legacyPrivateCache(version: 1 | 2): string {
  if (version === 1) {
    return JSON.stringify({
      version,
      timestamp: 1_786_000_000_000,
      planners: [{ tool: 'codex', error: 'legacy-v1-private-planner-diagnostic-canary' }],
      implementers: [
        {
          provider: 'openai',
          models: [{ id: 'legacy-v1-private-model-canary' }],
          error: 'legacy-v1-private-provider-diagnostic-canary',
        },
      ],
    });
  }
  return JSON.stringify({
    version,
    timestamp: 1_786_000_000_000,
    providers: [
      {
        provider: 'openai',
        models: [{ id: 'legacy-v2-private-model-canary' }],
        error: 'legacy-v2-private-provider-diagnostic-canary',
      },
    ],
    cliTools: [
      {
        tool: 'codex',
        diagnostic: { remediation: 'legacy-v2-private-cli-diagnostic-canary' },
      },
    ],
  });
}

describe('detection cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-cache-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when no cache exists', async () => {
    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
  });

  it('serializes only non-sensitive readiness and stat fingerprint evidence', async () => {
    const providers: ProviderDetection[] = [
      {
        provider: 'ollama',
        available: true,
        isLocal: true,
        hasKey: true,
        error: 'token-private-error-canary',
        models: [{ id: 'local-private-model-canary:7b' }],
      },
    ];
    const cliTools: CliToolDetection[] = [
      {
        tool: 'codex',
        executable: {
          path: '/private/local-cli-path-canary/bin/codex',
          fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        },
        trust: 'trusted',
        installedVersion: '9.0.0',
        testedVersion: '0.40.0',
        compatibility: 'incompatible',
        auth: 'not-checked',
        diagnostic: {
          state: 'incompatible',
          remediation: 'credential-private-remediation-canary',
        },
        probedAt: 1_786_000_000_000,
      },
    ];

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ providers, cliTools }),
    });

    const raw = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');
    expect(raw).not.toContain('local-private-model-canary:7b');
    expect(raw).not.toContain('token-private-error-canary');
    expect(raw).not.toContain('/private/local-cli-path-canary');
    expect(raw).not.toContain('credential-private-remediation-canary');
    expect(raw).not.toContain('models');
    expect(JSON.parse(raw)).toEqual({
      version: 3,
      contextKey: CACHE_CONTEXT,
      fetchedAt: 1_786_000_000_000,
      validatedAt: 1_786_000_001_000,
      generation: 12,
      requestId: 27,
      providers: [{ provider: 'ollama', available: true, isLocal: true, hasKey: true }],
      cliTools: [
        {
          tool: 'codex',
          trust: 'trusted',
          installedVersion: '9.0.0',
          testedVersion: '0.40.0',
          compatibility: 'incompatible',
          auth: 'not-checked',
          diagnosticState: 'incompatible',
          probedAt: 1_786_000_000_000,
          fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        },
      ],
    });
  });

  it('never serializes role-scoped provider outcomes, catalogs, diagnostics, or connection canaries', async () => {
    const configuredProviderOutcomes: ConfiguredProviderOutcome[] = [
      {
        connection: {
          role: 'planner',
          provider: 'openai',
          contextKey: 'role-private-connection-canary',
        },
        outcome: {
          kind: 'failed',
          source: 'provider-runtime',
          provider: 'openai',
          isLocal: false,
          credential: 'present',
          failure: 'privacy-filtered',
          diagnostic: 'private-provider-diagnostic-canary',
        },
      },
    ];
    const snapshot = {
      ...cacheSnapshot({
        providers: [
          {
            provider: 'openai',
            available: true,
            isLocal: false,
            hasKey: true,
            models: [{ id: 'private-runtime-model-canary' }],
          },
        ],
      }),
      configuredProviderOutcomes,
    };

    await saveDetectionCache({ projectDir: tempDir, snapshot });

    const raw = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');
    expect(raw).not.toContain('role-private-connection-canary');
    expect(raw).not.toContain('private-provider-diagnostic-canary');
    expect(raw).not.toContain('private-runtime-model-canary');
    expect(raw).not.toContain('configuredProviderOutcomes');
    expect(raw).not.toContain('models');
  });

  it('retains original observation metadata while returning a sanitized projection', async () => {
    const cliTools: CliToolDetection[] = [
      cliDetectionFor('incompatible', 'codex', {
        executable: {
          path: join(tmpdir(), 'codex'),
          fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        },
        installedVersion: '9.0.0',
      }),
    ];

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliTools }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toMatchObject({
      contextKey: CACHE_CONTEXT,
      fetchedAt: 1_786_000_000_000,
      validatedAt: 1_786_000_001_000,
      generation: 12,
      requestId: 27,
      cliTools: [
        {
          executable: null,
          diagnostic: { state: 'incompatible', remediation: 'Run runner readiness again.' },
        },
      ],
    });
  });

  it('round-trips detections carrying a failure kind without their diagnostics', async () => {
    const providers: ProviderDetection[] = [
      {
        provider: 'openai',
        available: false,
        isLocal: false,
        hasKey: true,
        failure: 'invalid-credential',
        error: 'private-provider-diagnostic-canary',
      },
    ];

    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot({ providers }) });

    const raw = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');
    expect(raw).not.toContain('private-provider-diagnostic-canary');
    const loaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(loaded?.providers).toEqual([
      {
        provider: 'openai',
        available: false,
        isLocal: false,
        hasKey: true,
        failure: 'invalid-credential',
      },
    ]);
  });

  it('hydrates cache rows that predate the failure field with failure undefined', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'detection-cache.json'),
      JSON.stringify({
        version: 3,
        contextKey: CACHE_CONTEXT,
        fetchedAt: 1_786_000_000_000,
        validatedAt: 1_786_000_001_000,
        generation: 12,
        requestId: 27,
        providers: [{ provider: 'openai', available: false, isLocal: false, hasKey: true }],
        cliTools: [],
      }),
      'utf8',
    );

    const loaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(loaded?.providers).toEqual([
      { provider: 'openai', available: false, isLocal: false, hasKey: true },
    ]);
    expect(loaded?.providers[0]?.failure).toBeUndefined();
  });

  it('round-trips per-provider oracle facts without capturing credential values', async () => {
    const cliTools: CliToolDetection[] = [
      {
        tool: 'kilo-code',
        executable: {
          path: '/opt/kilo/bin/kilo',
          fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        },
        trust: 'trusted',
        installedVersion: '0.1.0',
        testedVersion: '0.1.0',
        compatibility: 'compatible',
        auth: 'authenticated',
        providerAuth: [
          { provider: 'GitHub Copilot', source: 'oauth' },
          { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
        ],
        diagnostic: { state: 'ready', remediation: null },
        probedAt: 1_786_000_000_000,
      },
    ];

    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot({ cliTools }) });

    const loaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(loaded?.cliTools[0]?.providerAuth).toEqual([
      { provider: 'GitHub Copilot', source: 'oauth' },
      { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
    ]);
  });

  it('hydrates cache rows that predate providerAuth with the field undefined', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'detection-cache.json'),
      JSON.stringify({
        version: 3,
        contextKey: CACHE_CONTEXT,
        fetchedAt: 1_786_000_000_000,
        validatedAt: 1_786_000_001_000,
        generation: 12,
        requestId: 27,
        providers: [],
        cliTools: [
          {
            tool: 'opencode',
            trust: 'trusted',
            installedVersion: '0.5.0',
            testedVersion: '0.5.0',
            compatibility: 'compatible',
            auth: 'authenticated',
            diagnosticState: 'ready',
            probedAt: 1_786_000_000_000,
            fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
          },
        ],
      }),
      'utf8',
    );

    const loaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(loaded?.cliTools[0]).toMatchObject({ tool: 'opencode', auth: 'authenticated' });
    expect(loaded?.cliTools[0]?.providerAuth).toBeUndefined();
  });

  it('does not reuse a cache record for a different context', async () => {
    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot() });
    const cachePath = join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json');
    const before = await readFile(cachePath, 'utf8');

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: 'other-context-v1' }),
    ).resolves.toBeNull();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(before);
  });

  it.each([
    'sk-private-context-canary',
    'acct_private_context_canary',
  ])('refuses to persist a credential-like or account-visible context key', async (contextKey) => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ contextKey }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
    ).resolves.toBeNull();
  });

  it('refuses to persist a digest-shaped version value', async () => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        cliTools: [cliDetectionFor('ready', 'claude-code', { installedVersion: 'sha256-canary' })],
      }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
  });

  it('preserves malformed files but securely scrubs known private legacy cache payloads', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    const malformed = 'not valid json';
    const cachePath = join(dir, 'detection-cache.json');
    await writeFile(cachePath, malformed, 'utf8');

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(malformed);

    for (const version of [1, 2] as const) {
      await writeFile(cachePath, legacyPrivateCache(version), 'utf8');
      await expect(
        loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
      ).resolves.toBeNull();
      await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps the legacy projection reader bounded by its TTL', async () => {
    const cliTools: CliToolDetection[] = [cliDetectionFor('ready', 'claude-code')];
    await saveDetectionCache(tempDir, [], cliTools);

    await expect(loadDetectionCache(tempDir, 0)).resolves.toBeNull();
    await expect(loadDetectionCache(tempDir, 60_000)).resolves.toMatchObject({
      providers: [],
      cliTools: [{ tool: 'claude-code' }],
    });
  });

  itUnix('does not follow a .splitbrief symlink outside the project', async () => {
    const projectDir = createTempDir('cache-symlink-splitbrief');
    const outside = createTempDir('cache-symlink-outside');
    try {
      mkdirSync(join(outside, 'nested'), { recursive: true });
      const outsideCachePath = join(outside, 'detection-cache.json');
      const outsideCache = JSON.stringify({
        version: 2,
        timestamp: 1_786_000_000_000,
        providers: [{ provider: 'openai', models: [{ id: 'outside-private-model' }] }],
        cliTools: [],
      });
      writeFileSync(outsideCachePath, outsideCache);
      symlinkSync(outside, join(projectDir, SPLITBRIEF_DIR));

      await expect(
        loadDetectionCacheSnapshot({ projectDir, contextKey: CACHE_CONTEXT }),
      ).resolves.toBeNull();
      await expect(readFile(outsideCachePath, 'utf8')).resolves.toBe(outsideCache);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(projectDir);
    }
  });

  it('does not throw when the save target is unavailable', async () => {
    await expect(
      saveDetectionCache({
        projectDir: '/nonexistent/readonly/path',
        snapshot: cacheSnapshot(),
      }),
    ).resolves.toBeUndefined();
  });

  it('removes an existing cache only when explicitly invalidated', async () => {
    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot() });
    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.not.toBeNull();

    await invalidateCache(tempDir);

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
  });
});
