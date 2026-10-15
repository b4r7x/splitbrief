import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { cliDetectionFor, PROBE_EXECUTABLE } from '#testing/helpers/factories/detection.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import {
  MAX_CLI_CATALOG_READ_MODELS,
  mergeCatalogRead,
} from '../../core/discovery/catalog-read-merge.js';
import { detectionContextsForCurrentConfig } from './store-publication.js';
import type { DetectionCacheSnapshot, RememberedCliCatalog } from './cache.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import {
  invalidateCache,
  loadDetectionCacheSnapshot,
  loadRememberedCliRuntime,
  loadRememberedPresentationSnapshot,
  saveDetectionCache,
} from './cache.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const CACHE_CONTEXT = 'readiness-context-v1';
const PROVIDER_CACHE_LIMIT = 500;

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
          provider: 'custom-endpoint',
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
        provider: 'custom-endpoint',
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

  it('warns and writes nothing when the snapshot fails schema validation', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let written = '';
    try {
      // ':' is outside the accepted context-key alphabet.
      await saveDetectionCache({
        projectDir: tempDir,
        snapshot: cacheSnapshot({ contextKey: 'readiness:not-a-persistable-key' }),
      });
      written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      stderr.mockRestore();
    }

    expect(written).toContain('detection cache: snapshot not remembered');
    expect(written).toContain('contextKey');
    expect(written).not.toContain('not-a-persistable-key');
    await expect(
      readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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
    expect(raw).not.toContain('token-private-error-canary');
    expect(raw).not.toContain('/private/local-cli-path-canary');
    expect(raw).not.toContain('credential-private-remediation-canary');
    expect(JSON.parse(raw)).toEqual({
      version: 6,
      contextKey: CACHE_CONTEXT,
      fetchedAt: 1_786_000_000_000,
      validatedAt: 1_786_000_001_000,
      generation: 12,
      requestId: 27,
      providers: [
        {
          provider: 'ollama',
          available: true,
          isLocal: true,
          hasKey: true,
          models: [{ id: 'local-private-model-canary:7b' }],
        },
      ],
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

  it('serializes sanitized remembered model rows and drops credential-shaped ids', async () => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        providers: [
          {
            provider: 'ollama',
            available: true,
            isLocal: false,
            hasKey: true,
            models: [
              {
                id: 'deepseek/deepseek-chat',
                contextLength: 131_072,
                releaseDate: '2025-11-01',
                pricingInput: 3,
                pricingOutput: 12,
                nativeHidden: false,
                displayName: 'DeepSeek Chat',
              },
              { id: 'sk-credential-shaped-model' },
              { id: 'model id with spaces' },
            ],
          },
        ],
        cliCatalogs: [
          {
            tool: 'claude-code',
            models: [
              { id: 'claude-fable-5', contextLength: 200_000, nativeDefault: true },
              { id: 'sk-credential-shaped-model' },
            ],
            missingOnce: ['claude-fable-5', 'sk-credential-shaped-model'],
            probedAt: 1_786_000_000_500,
          },
        ],
      }),
    });

    const raw = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');
    expect(raw).not.toContain('sk-credential-shaped-model');
    expect(raw).not.toContain('model id with spaces');
    expect(raw).toContain('DeepSeek Chat');
    expect(JSON.parse(raw).cliCatalogs[0]).not.toHaveProperty('role');

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toMatchObject({
      providers: [
        {
          provider: 'ollama',
          models: [
            {
              id: 'deepseek/deepseek-chat',
              contextLength: 131_072,
              nativeHidden: false,
              displayName: 'DeepSeek Chat',
            },
          ],
        },
      ],
      cliCatalogs: [
        {
          tool: 'claude-code',
          models: [{ id: 'claude-fable-5', contextLength: 200_000, nativeDefault: true }],
          missingOnce: ['claude-fable-5'],
          probedAt: 1_786_000_000_500,
        },
      ],
    });
  });

  it.each([{ missingOnce: undefined }, { missingOnce: ['model-b'] }])(
    'round-trips a catalog with optional missing marks ($missingOnce)',
    async ({ missingOnce }) => {
      const cliCatalogs = [
        {
          tool: 'codex' as const,
          models: [{ id: 'model-a' }, { id: 'model-b' }],
          probedAt: 1_786_000_000_500,
          ...(missingOnce === undefined ? {} : { missingOnce }),
        },
      ];
      await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot({ cliCatalogs }) });
      const loaded = await loadDetectionCacheSnapshot({
        projectDir: tempDir,
        contextKey: CACHE_CONTEXT,
      });
      expect(loaded?.cliCatalogs).toEqual(cliCatalogs);
      const presentation = await loadRememberedPresentationSnapshot({
        projectDir: tempDir,
        contextKey: 'other-context',
      });
      expect(presentation?.snapshot.cliCatalogs).toEqual(cliCatalogs);
    },
  );

  it('keeps a swapped model at the read bound until a second read confirms its absence', async () => {
    const cachedModels = Array.from({ length: MAX_CLI_CATALOG_READ_MODELS }, (_, index) => ({
      id: `model-${index}`,
    }));
    const previousCatalog: RememberedCliCatalog = {
      tool: 'codex',
      models: cachedModels,
      probedAt: 1_786_000_000_500,
    };
    const cacheDir = join(tempDir, SPLITBRIEF_DIR);
    const cachePath = join(cacheDir, 'detection-cache.json');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({ version: 6, ...cacheSnapshot({ cliCatalogs: [previousCatalog] }) }),
      'utf8',
    );
    const previous = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(previous?.cliCatalogs).toEqual([previousCatalog]);

    const readModels = [...cachedModels.slice(1), { id: 'model-new' }];
    const first = mergeCatalogRead({
      cachedModels: previous?.cliCatalogs?.[0]?.models,
      missingOnce: previous?.cliCatalogs?.[0]?.missingOnce,
      readModels,
    });
    const firstCatalog: RememberedCliCatalog = {
      ...previousCatalog,
      models: first.models,
      missingOnce: first.missingOnce,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [firstCatalog] }),
    });
    const savedFirst = JSON.parse(await readFile(cachePath, 'utf8')).cliCatalogs[0];
    expect(savedFirst.models).toHaveLength(MAX_CLI_CATALOG_READ_MODELS + 1);
    expect(savedFirst.missingOnce).toEqual(['model-0']);
    expect(savedFirst).toEqual(firstCatalog);

    const reloaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(reloaded?.cliCatalogs).toEqual([firstCatalog]);
    const presentation = await loadRememberedPresentationSnapshot({
      projectDir: tempDir,
      contextKey: 'other-context',
    });
    expect(presentation?.snapshot.cliCatalogs).toEqual([firstCatalog]);

    const second = mergeCatalogRead({
      cachedModels: reloaded?.cliCatalogs?.[0]?.models,
      missingOnce: reloaded?.cliCatalogs?.[0]?.missingOnce,
      readModels,
    });
    expect(second.missingOnce).toEqual([]);
    const secondCatalog: RememberedCliCatalog = {
      tool: previousCatalog.tool,
      models: second.models,
      probedAt: previousCatalog.probedAt + 1,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [secondCatalog] }),
    });
    const savedSecond = JSON.parse(await readFile(cachePath, 'utf8')).cliCatalogs[0];
    expect(savedSecond.models).toHaveLength(MAX_CLI_CATALOG_READ_MODELS);
    expect(savedSecond.models).toEqual(readModels);
    expect(savedSecond).not.toHaveProperty('missingOnce');
    const confirmed = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(confirmed?.cliCatalogs).toEqual([secondCatalog]);
  });

  it.each([0, MAX_CLI_CATALOG_READ_MODELS / 2, MAX_CLI_CATALOG_READ_MODELS])(
    'keeps all models and marks at the read bound after their first absence from a %i-row read',
    async (readSize) => {
      const cachedModels = Array.from({ length: MAX_CLI_CATALOG_READ_MODELS }, (_, index) => ({
        id: `old-${index}`,
      }));
      const readModels = Array.from({ length: readSize }, (_, index) => ({ id: `new-${index}` }));
      const read = mergeCatalogRead({ cachedModels, missingOnce: undefined, readModels });
      const catalog: RememberedCliCatalog = {
        tool: 'opencode',
        models: read.models,
        missingOnce: read.missingOnce,
        probedAt: 1_786_000_000_500,
      };
      await saveDetectionCache({
        projectDir: tempDir,
        snapshot: cacheSnapshot({ cliCatalogs: [catalog] }),
      });
      const raw = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');
      const saved = JSON.parse(raw).cliCatalogs[0];
      expect(saved.models).toHaveLength(MAX_CLI_CATALOG_READ_MODELS + readSize);
      expect(saved.missingOnce).toEqual(cachedModels.map((model) => model.id));
      expect(saved).toEqual(catalog);
      const reloaded = await loadDetectionCacheSnapshot({
        projectDir: tempDir,
        contextKey: CACHE_CONTEXT,
      });
      expect(reloaded?.cliCatalogs).toEqual([catalog]);
    },
  );

  it('round-trips exactly twice the read bound with a full read of missing marks', async () => {
    const unmarkedModels = Array.from({ length: MAX_CLI_CATALOG_READ_MODELS }, (_, index) => ({
      id: `model-${index}`,
    }));
    const missingModels = Array.from({ length: MAX_CLI_CATALOG_READ_MODELS }, (_, index) => ({
      id: `missing-${index}`,
    }));
    const missingOnce = missingModels.map((model) => model.id);
    const catalog: RememberedCliCatalog = {
      tool: 'codex',
      models: [...unmarkedModels, ...missingModels],
      missingOnce,
      probedAt: 1_786_000_000_500,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [catalog] }),
    });
    const reloaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(reloaded?.cliCatalogs).toEqual([catalog]);
  });

  it('remembers 600 absences across a restart and removes them on the second empty read', async () => {
    const models = Array.from({ length: 600 }, (_, index) => ({ id: `model-${index}` }));
    const initialCatalog: RememberedCliCatalog = {
      tool: 'opencode',
      models: models.slice(0, 500),
      probedAt: 1_786_000_000_500,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [initialCatalog] }),
    });
    const initial = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(initial?.cliCatalogs).toEqual([initialCatalog]);

    const growth = mergeCatalogRead({
      cachedModels: initial?.cliCatalogs?.[0]?.models,
      missingOnce: initial?.cliCatalogs?.[0]?.missingOnce,
      readModels: models,
    });
    const grownCatalog: RememberedCliCatalog = {
      ...initialCatalog,
      models: growth.models,
      probedAt: initialCatalog.probedAt + 1,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [grownCatalog] }),
    });
    const grown = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(grown?.cliCatalogs).toEqual([grownCatalog]);

    const firstEmpty = mergeCatalogRead({
      cachedModels: grown?.cliCatalogs?.[0]?.models,
      missingOnce: grown?.cliCatalogs?.[0]?.missingOnce,
      readModels: [],
    });
    const missingCatalog: RememberedCliCatalog = {
      ...grownCatalog,
      models: firstEmpty.models,
      missingOnce: firstEmpty.missingOnce,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [missingCatalog] }),
    });
    const restarted = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(restarted?.cliCatalogs).toEqual([missingCatalog]);
    expect(restarted?.cliCatalogs?.[0]?.models).toEqual(models);
    expect(restarted?.cliCatalogs?.[0]?.missingOnce).toEqual(models.map((model) => model.id));

    const secondEmpty = mergeCatalogRead({
      cachedModels: restarted?.cliCatalogs?.[0]?.models,
      missingOnce: restarted?.cliCatalogs?.[0]?.missingOnce,
      readModels: [],
    });
    expect(secondEmpty).toEqual({ models: [], missingOnce: [], complete: false });
    const emptyCatalog: RememberedCliCatalog = {
      ...grownCatalog,
      models: secondEmpty.models,
      missingOnce: secondEmpty.missingOnce,
    };
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ cliCatalogs: [emptyCatalog] }),
    });
    const confirmed = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(confirmed?.cliCatalogs).toEqual([emptyCatalog]);
  });

  it('keeps the provider model limit at 500 sanitized rows', async () => {
    const models = Array.from({ length: PROVIDER_CACHE_LIMIT + 1 }, (_, index) => ({
      id: `model-${index}`,
    }));
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        providers: [
          {
            provider: 'ollama',
            available: true,
            isLocal: true,
            models: [{ id: 'sk-credential-shaped-model' }, ...models],
          },
        ],
      }),
    });
    const reloaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(reloaded?.providers[0]?.models).toEqual(models.slice(0, PROVIDER_CACHE_LIMIT));
  });

  it('round-trips an embedding capability fact so a cold start can drop that row', async () => {
    const models = [
      { id: 'openai/gpt-5.6-luna' },
      { id: 'openai/text-embedding-3-large', capabilities: ['type:embedding'] },
    ];
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        cliCatalogs: [{ tool: 'opencode', models, probedAt: 1_786_000_000_500 }],
      }),
    });

    const snapshot = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(snapshot?.cliCatalogs?.[0]?.models).toEqual(models);
  });

  it('drops a non-ISO release date but keeps the model row', async () => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        cliCatalogs: [
          {
            tool: 'codex',
            models: [{ id: 'model-with-odd-date', releaseDate: 'last tuesday' }],
            probedAt: 1_786_000_000_500,
          },
        ],
      }),
    });

    const snapshot = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(snapshot?.cliCatalogs?.[0]?.models).toEqual([{ id: 'model-with-odd-date' }]);
  });

  it("remembers the tool's own name, detail, ladder and modality flags per model", async () => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        cliCatalogs: [
          {
            tool: 'command-code',
            models: [
              {
                id: 'zai-org/glm-5.2',
                displayName: 'GLM-5.2',
                detail: 'powerful coding with 1M context',
                nativeReasoningEfforts: ['low', 'high'],
                nativeDefaultReasoningEffort: 'high',
                supportsToolCalls: true,
                outputModalities: ['text'],
              },
            ],
            probedAt: 1_786_000_000_500,
          },
        ],
      }),
    });

    await expect(
      loadRememberedPresentationSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toMatchObject({
      snapshot: {
        cliCatalogs: [
          {
            tool: 'command-code',
            models: [
              {
                id: 'zai-org/glm-5.2',
                displayName: 'GLM-5.2',
                detail: 'powerful coding with 1M context',
                nativeReasoningEfforts: ['low', 'high'],
                nativeDefaultReasoningEffort: 'high',
                supportsToolCalls: true,
                outputModalities: ['text'],
              },
            ],
          },
        ],
      },
    });
  });

  it('drops a credential-shaped detail but keeps the row', async () => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({
        cliCatalogs: [
          {
            tool: 'command-code',
            models: [{ id: 'x/y', displayName: 'X Y', detail: 'uses api_key auth' }],
            probedAt: 1_786_000_000_500,
          },
        ],
      }),
    });

    const remembered = await loadRememberedPresentationSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    const row = remembered?.snapshot.cliCatalogs?.[0]?.models[0];
    expect(row).toMatchObject({ id: 'x/y', displayName: 'X Y' });
    expect(row).not.toHaveProperty('detail');
  });

  it('hydrates cache rows that predate remembered catalogs with the field undefined', async () => {
    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot() });

    const snapshot = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.cliCatalogs).toBeUndefined();
  });

  it('never serializes role-scoped provider outcomes, diagnostics, or connection canaries', async () => {
    const configuredProviderOutcomes: ConfiguredProviderOutcome[] = [
      {
        connection: {
          role: 'planner',
          provider: 'ollama',
          contextKey: 'role-private-connection-canary',
        },
        outcome: {
          kind: 'failed',
          source: 'provider-runtime',
          provider: 'ollama',
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
            provider: 'ollama',
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
    expect(raw).not.toContain('configuredProviderOutcomes');
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
          diagnostic: { state: 'incompatible', remediation: 'Run `splitbrief doctor` again.' },
        },
      ],
    });
  });

  it('round-trips a realistic configured context longer than the legacy cache bound', async () => {
    const contextKey = detectionContextsForCurrentConfig({
      config: createDefaultConfig(),
      projectDir: tempDir,
    }).readiness;
    const cliTool = cliDetectionFor('ready', 'claude-code');
    expect(contextKey.length).toBeGreaterThan(512);

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ contextKey, cliTools: [cliTool] }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
    ).resolves.toMatchObject({
      contextKey,
      cliTools: [{ tool: 'claude-code', executable: null, diagnostic: { state: 'ready' } }],
    });
  });

  it('caches a context naming the api-key channel without reading it as credential material', async () => {
    const contextKey = detectionContextsForCurrentConfig({
      config: {
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
      },
      projectDir: tempDir,
    }).readiness;
    expect(contextKey).toContain('api-key');

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ contextKey, cliTools: [cliDetectionFor('ready', 'claude-code')] }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
    ).resolves.toMatchObject({ contextKey });
  });

  it('caches a context naming the CUSTOM_ENDPOINT_API_KEY environment variable', async () => {
    const contextKey = detectionContextsForCurrentConfig({
      config: {
        ...createDefaultConfig(),
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://custom-endpoint.example/v1',
          apiKey: 'env:CUSTOM_ENDPOINT_API_KEY',
          model: 'gpt-5-mini',
        },
      },
      projectDir: tempDir,
    }).readiness;
    expect(contextKey).toContain('CUSTOM_ENDPOINT_API_KEY');

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ contextKey, cliTools: [cliDetectionFor('ready', 'claude-code')] }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
    ).resolves.toMatchObject({ contextKey });
  });

  it.each(['my-local-app', 'ai-model-server', 'my-private-app', 'team-account-service'])(
    'remembers detection for a project folder named %s',
    async (folder) => {
      const projectDir = join(tempDir, 'work', folder);
      await mkdir(projectDir, { recursive: true });
      const contextKey = detectionContextsForCurrentConfig({
        config: createDefaultConfig(),
        projectDir,
      }).readiness;
      expect(contextKey).not.toContain(folder);

      await saveDetectionCache({
        projectDir,
        snapshot: cacheSnapshot({
          contextKey,
          cliTools: [cliDetectionFor('ready', 'claude-code')],
        }),
      });

      await expect(loadDetectionCacheSnapshot({ projectDir, contextKey })).resolves.toMatchObject({
        contextKey,
      });
    },
  );

  it('still refuses a digest-shaped model id in a project folder named my-local-app', async () => {
    const projectDir = join(tempDir, 'work', 'my-local-app');
    await mkdir(projectDir, { recursive: true });
    const contextKey = detectionContextsForCurrentConfig({
      config: {
        ...createDefaultConfig(),
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://custom-endpoint.example/v1',
          apiKey: 'env:CUSTOM_ENDPOINT_API_KEY',
          model: 'f'.repeat(64),
        },
      },
      projectDir,
    }).readiness;

    await saveDetectionCache({
      projectDir,
      snapshot: cacheSnapshot({ contextKey, cliTools: [cliDetectionFor('ready', 'claude-code')] }),
    });

    await expect(loadDetectionCacheSnapshot({ projectDir, contextKey })).resolves.toBeNull();
  });

  it('still refuses a context carrying real credential material', async () => {
    const contextKey = 'detection-context-v1|darwin|api-key|sk-live-abcdefghijklmnop';

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ contextKey, cliTools: [cliDetectionFor('ready', 'claude-code')] }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
    ).resolves.toBeNull();
  });

  it('keeps generated cache contexts bounded', async () => {
    const contextKey = 'a'.repeat(16 * 1_024 + 1);
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ contextKey }),
    });

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
    ).resolves.toBeNull();
  });

  it('round-trips detections carrying a failure kind without their diagnostics', async () => {
    const providers: ProviderDetection[] = [
      {
        provider: 'ollama',
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
        provider: 'ollama',
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
        version: 6,
        contextKey: CACHE_CONTEXT,
        fetchedAt: 1_786_000_000_000,
        validatedAt: 1_786_000_001_000,
        generation: 12,
        requestId: 27,
        providers: [{ provider: 'ollama', available: false, isLocal: false, hasKey: true }],
        cliTools: [],
      }),
      'utf8',
    );

    const loaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(loaded?.providers).toEqual([
      { provider: 'ollama', available: false, isLocal: false, hasKey: true },
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
        providerAuth: {
          kind: 'read',
          facts: [
            { provider: 'GitHub Copilot', source: 'oauth' },
            { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
          ],
        },
        diagnostic: { state: 'ready', remediation: null },
        probedAt: 1_786_000_000_000,
      },
    ];

    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot({ cliTools }) });

    const loaded = await loadDetectionCacheSnapshot({
      projectDir: tempDir,
      contextKey: CACHE_CONTEXT,
    });
    expect(loaded?.cliTools[0]?.providerAuth).toEqual({
      kind: 'read',
      facts: [
        { provider: 'GitHub Copilot', source: 'oauth' },
        { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
      ],
    });
  });

  it('hydrates a cache row with no recorded listing for an oracle tool as not probed', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'detection-cache.json'),
      JSON.stringify({
        version: 6,
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
    expect(loaded?.cliTools[0]?.providerAuth).toEqual({
      kind: 'unreadable',
      reason: 'not-probed',
    });
  });

  it('hydrates a cache row whose listing predates the provider-auth union', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'detection-cache.json'),
      JSON.stringify({
        version: 6,
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
            providerAuth: [{ provider: 'OpenAI', source: 'oauth' }],
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
    expect(loaded?.cliTools[0]?.providerAuth).toEqual({
      kind: 'read',
      facts: [{ provider: 'OpenAI', source: 'oauth' }],
    });
  });

  it('rejects a version-3 cache payload without unlinking it', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    const cachePath = join(dir, 'detection-cache.json');
    const payload = JSON.stringify({
      version: 3,
      contextKey: CACHE_CONTEXT,
      fetchedAt: 1_786_000_000_000,
      validatedAt: 1_786_000_001_000,
      generation: 12,
      requestId: 27,
      providers: [],
      cliTools: [],
    });
    await writeFile(cachePath, payload, 'utf8');

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(payload);
  });

  it('discards a version-5 role-keyed cache instead of migrating it', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    const cachePath = join(dir, 'detection-cache.json');
    const payload = JSON.stringify({
      version: 5,
      contextKey: CACHE_CONTEXT,
      fetchedAt: 1_786_000_000_000,
      validatedAt: 1_786_000_001_000,
      generation: 12,
      requestId: 27,
      providers: [],
      cliTools: [],
      cliCatalogs: [
        { role: 'planner', tool: 'codex', models: [{ id: 'gpt-5.2-codex' }], probedAt: 40 },
      ],
    });
    await writeFile(cachePath, payload, 'utf8');

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(payload);
  });

  it('rejects a version-6 remembered catalog that still carries a role', async () => {
    const dir = join(tempDir, SPLITBRIEF_DIR);
    await mkdir(dir, { recursive: true });
    const cachePath = join(dir, 'detection-cache.json');
    const payload = JSON.stringify({
      version: 6,
      contextKey: CACHE_CONTEXT,
      fetchedAt: 1_786_000_000_000,
      validatedAt: 1_786_000_001_000,
      generation: 12,
      requestId: 27,
      providers: [],
      cliTools: [],
      cliCatalogs: [
        { role: 'planner', tool: 'codex', models: [{ id: 'gpt-5.2-codex' }], probedAt: 40 },
      ],
    });
    await writeFile(cachePath, payload, 'utf8');

    await expect(
      loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
    ).resolves.toBeNull();
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(payload);
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

  it.each(['sk-private-context-canary', 'acct_private_context_canary'])(
    'refuses to persist a credential-like or account-visible context key',
    async (contextKey) => {
      await saveDetectionCache({
        projectDir: tempDir,
        snapshot: cacheSnapshot({ contextKey }),
      });

      await expect(
        loadDetectionCacheSnapshot({ projectDir: tempDir, contextKey }),
      ).resolves.toBeNull();
    },
  );

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

  it('keeps the remembered runtime reader bounded by its TTL', async () => {
    const cliTools: CliToolDetection[] = [cliDetectionFor('ready', 'claude-code')];
    await saveDetectionCache({ projectDir: tempDir, snapshot: cacheSnapshot({ cliTools }) });

    await expect(
      loadRememberedCliRuntime({ projectDir: tempDir, tool: 'claude-code' }),
    ).resolves.toBeNull();

    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: cacheSnapshot({ fetchedAt: Date.now(), cliTools }),
    });

    await expect(
      loadRememberedCliRuntime({ projectDir: tempDir, tool: 'claude-code' }),
    ).resolves.toMatchObject({ installedVersion: cliTools[0]?.installedVersion });
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
        providers: [{ provider: 'custom-endpoint', models: [{ id: 'outside-private-model' }] }],
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

  describe('remembered CLI runtime', () => {
    async function rememberCliTools(cliTools: CliToolDetection[]): Promise<void> {
      await saveDetectionCache({
        projectDir: tempDir,
        snapshot: cacheSnapshot({ fetchedAt: Date.now(), cliTools }),
      });
    }

    it('returns the remembered version bound to the executable it was probed against', async () => {
      const remembered = cliDetectionFor('ready', 'claude-code');
      await rememberCliTools([remembered]);

      await expect(
        loadRememberedCliRuntime({ projectDir: tempDir, tool: 'claude-code' }),
      ).resolves.toEqual({
        installedVersion: remembered.installedVersion,
        fingerprint: { ...PROBE_EXECUTABLE.fingerprint },
      });
    });

    it('withholds a version when the record carries no row for the requested tool', async () => {
      await rememberCliTools([cliDetectionFor('ready', 'codex')]);

      await expect(
        loadRememberedCliRuntime({ projectDir: tempDir, tool: 'claude-code' }),
      ).resolves.toBeNull();
    });

    it('withholds a version the record never bound to an executable', async () => {
      await rememberCliTools([cliDetectionFor('unavailable', 'claude-code')]);

      await expect(
        loadRememberedCliRuntime({ projectDir: tempDir, tool: 'claude-code' }),
      ).resolves.toBeNull();
    });

    it('withholds an executable whose row records no installed version', async () => {
      const untrusted = cliDetectionFor('untrusted', 'claude-code');
      expect(untrusted.executable).not.toBeNull();
      await rememberCliTools([untrusted]);

      await expect(
        loadRememberedCliRuntime({ projectDir: tempDir, tool: 'claude-code' }),
      ).resolves.toBeNull();
    });
  });

  describe('remembered presentation snapshot', () => {
    it('returns null when no cache exists', async () => {
      await expect(
        loadRememberedPresentationSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
      ).resolves.toBeNull();
    });

    it('returns the snapshot with foreignContext: false when contextKey matches', async () => {
      const cliTools: CliToolDetection[] = [cliDetectionFor('ready', 'claude-code')];
      await saveDetectionCache({
        projectDir: tempDir,
        snapshot: cacheSnapshot({ contextKey: CACHE_CONTEXT, cliTools }),
      });

      const result = await loadRememberedPresentationSnapshot({
        projectDir: tempDir,
        contextKey: CACHE_CONTEXT,
      });

      expect(result).not.toBeNull();
      expect(result?.foreignContext).toBe(false);
      expect(result?.snapshot).toMatchObject({
        contextKey: CACHE_CONTEXT,
        cliTools: [{ tool: 'claude-code' }],
      });
    });

    it('returns the snapshot with foreignContext: true when contextKey differs', async () => {
      const cliTools: CliToolDetection[] = [cliDetectionFor('ready', 'claude-code')];
      await saveDetectionCache({
        projectDir: tempDir,
        snapshot: cacheSnapshot({ contextKey: CACHE_CONTEXT, cliTools }),
      });

      const result = await loadRememberedPresentationSnapshot({
        projectDir: tempDir,
        contextKey: 'other-context-v2',
      });

      expect(result).not.toBeNull();
      expect(result?.foreignContext).toBe(true);
      expect(result?.snapshot).toMatchObject({
        contextKey: CACHE_CONTEXT,
        cliTools: [{ tool: 'claude-code' }],
      });
    });

    it('returns null for legacy v1 or v2 cache records and scrubs them', async () => {
      const dir = join(tempDir, SPLITBRIEF_DIR);
      await mkdir(dir, { recursive: true });
      const cachePath = join(dir, 'detection-cache.json');

      for (const version of [1, 2] as const) {
        await writeFile(cachePath, legacyPrivateCache(version), 'utf8');
        await expect(
          loadRememberedPresentationSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
        ).resolves.toBeNull();
        await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

    it('returns null for malformed or schema-invalid cache records without deleting them', async () => {
      const dir = join(tempDir, SPLITBRIEF_DIR);
      await mkdir(dir, { recursive: true });
      const cachePath = join(dir, 'detection-cache.json');

      await writeFile(cachePath, 'not valid json', 'utf8');
      await expect(
        loadRememberedPresentationSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
      ).resolves.toBeNull();
      await expect(readFile(cachePath, 'utf8')).resolves.toBe('not valid json');

      const v3Payload = JSON.stringify({
        version: 3,
        contextKey: CACHE_CONTEXT,
        fetchedAt: 1_786_000_000_000,
        validatedAt: 1_786_000_001_000,
        generation: 12,
        requestId: 27,
        providers: [],
        cliTools: [],
      });
      await writeFile(cachePath, v3Payload, 'utf8');
      await expect(
        loadRememberedPresentationSnapshot({ projectDir: tempDir, contextKey: CACHE_CONTEXT }),
      ).resolves.toBeNull();
      await expect(readFile(cachePath, 'utf8')).resolves.toBe(v3Payload);
    });
  });
});
