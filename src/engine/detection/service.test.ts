import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { projectRunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { CliReadinessFacts } from '../../core/schemas/readiness.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ProbeOutcome } from '../../core/discovery/runner-evidence.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { deepFreeze } from '../../utils/deep-freeze.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { detectionContextKey } from './types.js';
import { scopedCliCatalogConnection } from './cli-catalog-outcomes.js';
import { createProductionDetectionDeps } from './deps.js';
import { loadRememberedSnapshot, saveDetectionCache } from './cache.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import type { ModelsDevCatalogCacheOutcome } from '../providers/models-dev-cache.js';
import { fetchModelsDevCatalogWithCache } from '../providers/models-dev.js';
import {
  createDetectionService,
  type DetectionDeps,
  type DetectionRefreshOutcomes,
  type DetectionSourceContexts,
  type DetectionServiceResult,
  type ResolvedDetectionSourceContexts,
} from './service.js';

const makeCliTool = (
  overrides: { tool?: CliToolDetection['tool'] } & Partial<CliReadinessFacts> = {},
): CliToolDetection => {
  const { tool = 'claude-code', ...facts } = overrides;
  return cliDetectionFor('ready', tool, facts);
};

const makeProvider = (overrides?: Partial<ProviderDetection>): ProviderDetection => ({
  provider: 'ollama',
  available: true,
  isLocal: true,
  ...overrides,
});

function modelsDevOutcome(catalog: ModelsDevCatalog): ModelsDevCatalogCacheOutcome {
  return {
    kind: 'fresh',
    snapshot: {
      sourceUrl: 'https://models.dev/api.json',
      parserVersion: 'test-parser',
      catalog: deepFreeze(catalog),
      catalogState: Object.keys(catalog).length === 0 ? 'empty' : 'populated',
      fetchedAt: 1_700_000_000_000,
      validatedAt: 1_700_000_000_000,
    },
  };
}

function makeDeps(overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  let generation = 0;
  return {
    detectAll: async () => {
      generation += 1;
      return {
        providers: [makeProvider()],
        cliTools: [makeCliTool({ installedVersion: `gen-${generation}` })],
      };
    },
    fetchModelsDevCatalog: async () => modelsDevOutcome({}),
    discoverAllCliTools: async () => [],
    ...overrides,
  };
}

function createClock() {
  let current = 1_700_000_000_000;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

function outcomes(result: DetectionServiceResult): DetectionRefreshOutcomes {
  if (result.outcomes === undefined) throw new Error('Expected coordinator refresh outcomes.');
  return result.outcomes;
}

function sourceContext(source: string): string {
  return detectionContextKey({
    platform: process.platform,
    runner: `test-${source}`,
    configGeneration: 'test-config',
  });
}

function sourceContexts(): ResolvedDetectionSourceContexts {
  return {
    readiness: sourceContext('readiness'),
    modelsDev: sourceContext('models-dev'),
    cliModels: sourceContext('cli-models'),
  };
}

function legacyPrivateCache(version: 1 | 2): string {
  if (version === 1) {
    return JSON.stringify({
      version,
      timestamp: 1_700_000_000_000,
      planners: [{ tool: 'codex', error: 'legacy-v1-service-private-planner-diagnostic-canary' }],
      implementers: [
        {
          provider: 'ollama',
          models: [{ id: 'legacy-v1-service-private-model-canary' }],
          error: 'legacy-v1-service-private-provider-diagnostic-canary',
        },
      ],
    });
  }
  return JSON.stringify({
    version,
    timestamp: 1_700_000_000_000,
    providers: [
      {
        provider: 'ollama',
        models: [{ id: 'legacy-v2-service-private-model-canary' }],
        error: 'legacy-v2-service-private-provider-diagnostic-canary',
      },
    ],
    cliTools: [
      {
        tool: 'codex',
        diagnostic: { remediation: 'legacy-v2-service-private-cli-diagnostic-canary' },
      },
    ],
  });
}

function projectSourceContexts(
  input: Readonly<{
    authChannel: string;
    configGeneration: string;
    credentialDomain: string;
    endpointOrigin: string;
    projectDir: string;
  }>,
): DetectionSourceContexts {
  const context = (source: string) =>
    detectionContextKey({
      platform: process.platform,
      runner: `${source}:planner:claude-code:implementer:custom-endpoint`,
      authChannel: `${input.authChannel}:api-key`,
      endpointOrigin: `${input.endpointOrigin}:https://api.custom-endpoint.example`,
      credentialDomain: `${input.credentialDomain}:env:CUSTOM_ENDPOINT_API_KEY`,
      configGeneration: `${input.projectDir}:${input.configGeneration}`,
    });
  return {
    readiness: context('readiness'),
    modelsDev: context('models-dev'),
    cliModels: context('cli-models'),
  };
}

describe('createDetectionService', () => {
  let service: ReturnType<typeof createDetectionService>;
  let tempDir: string;

  it.each(['automatic', 'manual'] as const)(
    'shuts down an in-flight %s refresh and refuses later probes',
    async (mode) => {
      const signals: AbortSignal[] = [];
      const waitForAbort = (signal: AbortSignal): Promise<void> => {
        signals.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const deps = makeDeps({
        detectAll: async ({ signal }) => {
          await waitForAbort(signal);
          return { providers: [], cliTools: [] };
        },
        fetchModelsDevCatalog: async ({ signal }) => {
          await waitForAbort(signal);
          return modelsDevOutcome({});
        },
        discoverAllCliTools: async ({ signal }) => {
          await waitForAbort(signal);
          return [];
        },
      });
      const refresh =
        mode === 'automatic' ? service.loadDetection({ deps }) : service.refreshDetection({ deps });
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);

      await service.shutdown();

      expect(signals.every((signal) => signal.aborted)).toBe(true);
      const result = outcomes(await refresh);
      expect(Object.values(result).map((outcome) => outcome.kind)).toEqual([
        'not-run',
        'not-run',
        'not-run',
      ]);
      expect(result.readiness).toMatchObject({ reason: 'cancelled' });
      expect(result.modelsDev).toMatchObject({ reason: 'cancelled' });
      expect(result.cliModels).toMatchObject({ reason: 'cancelled' });

      await service.loadDetection({ deps });
      await service.refreshDetection({ deps: { ...deps, sourceContexts: sourceContexts() } });
      await service.shutdown();
      expect(signals).toHaveLength(3);
    },
  );

  it('refuses probes when shutdown interrupts the initial cache read', async () => {
    const observations: string[] = [];
    const deps = makeDeps({
      detectAll: async () => {
        observations.push('readiness');
        return { providers: [], cliTools: [] };
      },
      fetchModelsDevCatalog: async () => {
        observations.push('models-dev');
        return modelsDevOutcome({});
      },
      discoverAllCliTools: async () => {
        observations.push('cli-models');
        return [];
      },
    });
    const refresh = service.loadDetection({ deps, projectDir: tempDir });

    await service.shutdown();
    const result = outcomes(await refresh);

    expect(observations).toEqual([]);
    expect(result.readiness).toMatchObject({ kind: 'not-run', reason: 'cancelled' });
    expect(result.modelsDev).toMatchObject({ kind: 'not-run', reason: 'cancelled' });
    expect(result.cliModels).toMatchObject({ kind: 'not-run', reason: 'cancelled' });
  });

  it('shuts down without waiting for an observation that has not settled', async () => {
    const remote = Promise.withResolvers<ModelsDevCatalogCacheOutcome>();
    const signals: AbortSignal[] = [];
    const refresh = service.loadDetection({
      deps: makeDeps({
        fetchModelsDevCatalog: ({ signal }) => {
          signals.push(signal);
          return remote.promise;
        },
      }),
    });
    try {
      await service.shutdown();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      remote.resolve(modelsDevOutcome({}));
      await refresh;
    }
  });

  it('refuses a late cache save after readiness succeeds and shutdown settles', async () => {
    const ready = Promise.withResolvers<void>();
    const remote = Promise.withResolvers<ModelsDevCatalogCacheOutcome>();
    const refresh = service.loadDetection({
      projectDir: tempDir,
      deps: makeDeps({ fetchModelsDevCatalog: () => remote.promise }),
      onLane: (lane) => {
        if (lane.lane === 'readiness') {
          expect(lane.outcome.kind).toBe('fresh');
          ready.resolve();
        }
      },
    });
    try {
      await ready.promise;
      const acceptedSaves = service.getPendingSave();
      expect(service.shutdown()).toBe(acceptedSaves);
      await acceptedSaves;
      remote.resolve(modelsDevOutcome({}));
      await refresh;
      await service.getPendingSave();
      expect(service.getPendingSave()).toBe(acceptedSaves);
      await expect(
        readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      remote.resolve(modelsDevOutcome({}));
      await refresh;
    }
  });

  it('settles the cache saves accepted before shutdown', async () => {
    await service.loadDetection({ deps: makeDeps(), projectDir: tempDir });
    const acceptedSaves = service.getPendingSave();
    expect(service.shutdown()).toBe(acceptedSaves);
    await acceptedSaves;
    expect(await loadRememberedSnapshot(tempDir)).toMatchObject({
      cliTools: [{ installedVersion: 'gen-1' }],
    });
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-detection-service-test-'));
    await mkdir(join(tempDir, SPLITBRIEF_DIR));
    service = createDetectionService();
    modelCacheStore.reset();
  });

  afterEach(async () => {
    await service.getPendingSave();
    await rm(tempDir, { recursive: true, force: true });
    modelCacheStore.reset();
  });

  it('hydrates a project snapshot and keeps the public and CLI source snapshots available', async () => {
    const catalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
          },
        },
      },
    };
    const deps = makeDeps({
      fetchModelsDevCatalog: async () => modelsDevOutcome(catalog),
      discoverAllCliTools: async () => [
        {
          connection: {
            tool: 'opencode',
            contextKey: 'service-opencode-catalog',
          },
          outcome: { kind: 'success', value: [{ id: 'anthropic/claude-sonnet-4.6' }] },
        },
      ],
    });

    const first = await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    const second = await service.loadDetection({ deps, projectDir: tempDir });

    expect(first).toMatchObject({
      catalog,
      cliModels: [
        {
          connection: {
            tool: 'opencode',
            contextKey: 'service-opencode-catalog',
          },
          outcome: { kind: 'success', value: [{ id: 'anthropic/claude-sonnet-4.6' }] },
        },
      ],
      outcomes: {
        readiness: { kind: 'fresh' },
        modelsDev: { kind: 'fresh' },
        cliModels: { kind: 'fresh' },
      },
    });
    expect(second.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(outcomes(second).readiness).toMatchObject({ kind: 'fresh', origin: 'snapshot' });
  });

  it('keeps a Models.dev catalog from a cache outcome frozen by identity', async () => {
    const catalog = {
      openai: { id: 'openai', models: { demo: { id: 'demo', limit: { context: 128_000 } } } },
    };
    const result = await service.loadDetection({
      deps: makeDeps({ fetchModelsDevCatalog: async () => modelsDevOutcome(catalog) }),
    });

    expect(result.catalog).toBe(catalog);
    expect(Object.isFrozen(catalog.openai.models.demo.limit)).toBe(true);
    expect(() => {
      catalog.openai.models.demo.limit.context = 1;
    }).toThrow(TypeError);
  });

  it('keeps private readiness separate when project, channel, endpoint, and configuration context change', async () => {
    let observations = 0;
    let contexts = projectSourceContexts({
      projectDir: '/projects/alpha',
      authChannel: 'session',
      endpointOrigin: 'https://gateway.alpha.example',
      credentialDomain: 'env:ALPHA_API_KEY',
      configGeneration: 'alpha-config',
    });
    const deps: DetectionDeps = {
      detectAll: async () => {
        observations += 1;
        return {
          providers: [],
          cliTools: [makeCliTool({ installedVersion: `observation-${observations}` })],
        };
      },
      fetchModelsDevCatalog: async () => modelsDevOutcome({}),
      discoverAllCliTools: async () => [],
      get sourceContexts() {
        return contexts;
      },
    };

    const first = await service.loadDetection({ deps, projectDir: '/projects/alpha' });
    contexts = projectSourceContexts({
      projectDir: '/projects/bravo',
      authChannel: 'api-key',
      endpointOrigin: 'https://gateway.bravo.example',
      credentialDomain: 'env:BRAVO_API_KEY',
      configGeneration: 'bravo-config',
    });
    const second = await service.loadDetection({ deps, projectDir: '/projects/bravo' });

    expect(first.cliTools[0]?.installedVersion).toBe('observation-1');
    expect(second.cliTools[0]?.installedVersion).toBe('observation-2');
    expect(observations).toBe(2);
    expect(JSON.stringify(second)).not.toContain('ALPHA_API_KEY');
  });

  it('revalidates the real public cache manually and retains its stale HTTP failure unchanged', async () => {
    const clock = createClock();
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: { demo: { id: 'demo' } },
      },
    };
    const requests: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.headers);
      if (requests.length === 1) {
        response.writeHead(200, { ETag: '"catalog-v1"', 'Content-Type': 'application/json' });
        response.end(JSON.stringify(catalog));
        return;
      }
      if (requests.length === 2) {
        response.writeHead(304, { ETag: '"catalog-v1"' });
        response.end();
        return;
      }
      response.writeHead(500);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP models.dev test server address.');
    }
    const sourceUrl = `http://127.0.0.1:${address.port}/api.json`;

    try {
      const deps = makeDeps({
        now: clock.now,
        fetchModelsDevCatalog: ({ mode }) =>
          fetchModelsDevCatalogWithCache({
            cacheDir: join(tempDir, 'models-dev-cache'),
            mode,
            now: clock.now,
            sourceUrl,
          }),
      });

      const first = await service.loadDetection({ deps });
      clock.advance(1_000);
      const revalidated = await service.refreshDetection({ deps });
      clock.advance(1_000);
      const stale = await service.refreshDetection({ deps });

      expect(first.catalog).toEqual(catalog);
      expect(outcomes(revalidated).modelsDev).toMatchObject({
        kind: 'not-modified',
        origin: 'request',
        snapshot: {
          fetchedAt: 1_700_000_000_000,
          validatedAt: 1_700_000_001_000,
        },
      });
      expect(stale.catalog).toEqual(catalog);
      expect(outcomes(stale).modelsDev).toMatchObject({
        kind: 'stale',
        failure: {
          kind: 'http-error',
          message: 'Models.dev catalog request returned HTTP 500.',
        },
        snapshot: {
          fetchedAt: 1_700_000_000_000,
          validatedAt: 1_700_000_001_000,
          stale: true,
        },
      });
      expect(requests).toHaveLength(3);
      expect(requests[0]?.['if-none-match']).toBeUndefined();
      expect(requests[1]?.['if-none-match']).toBe('"catalog-v1"');
      expect(requests[2]?.['if-none-match']).toBe('"catalog-v1"');
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts a superseded real models.dev request, releases its socket, and never publishes it', async () => {
    const firstRequest = Promise.withResolvers<void>();
    const firstRequestAborted = Promise.withResolvers<void>();
    const firstSocketReleased = Promise.withResolvers<void>();
    const catalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { current: { id: 'current' } } },
    };
    let requestCount = 0;
    const server = http.createServer((request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        request.once('aborted', () => firstRequestAborted.resolve());
        request.socket.once('close', () => firstSocketReleased.resolve());
        firstRequest.resolve();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(catalog));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP models.dev test server address.');
    }
    const sourceUrl = `http://127.0.0.1:${address.port}/api.json`;
    const cacheDir = join(tempDir, 'supersession-models-dev-cache');
    const createSupersessionDeps = (contexts: DetectionSourceContexts): DetectionDeps => ({
      detectAll: async ({ signal }) => {
        signal.throwIfAborted();
        return { providers: [], cliTools: [] };
      },
      fetchModelsDevCatalog: ({ mode, signal }) =>
        fetchModelsDevCatalogWithCache({ cacheDir, mode, signal, sourceUrl }),
      discoverAllCliTools: async ({ signal }) => {
        signal.throwIfAborted();
        return [];
      },
      sourceContexts: contexts,
    });

    try {
      const oldContexts = projectSourceContexts({
        projectDir: tempDir,
        authChannel: 'api-key',
        endpointOrigin: 'https://old.example',
        credentialDomain: 'env:OLD_KEY',
        configGeneration: 'old-generation',
      });
      const newContexts = projectSourceContexts({
        projectDir: tempDir,
        authChannel: 'session',
        endpointOrigin: 'https://new.example',
        credentialDomain: 'env:NEW_KEY',
        configGeneration: 'new-generation',
      });

      const oldLoad = service.loadDetection({
        deps: createSupersessionDeps(oldContexts),
        projectDir: tempDir,
      });
      await firstRequest.promise;
      const newLoad = service.loadDetection({
        deps: createSupersessionDeps(newContexts),
        projectDir: tempDir,
      });

      await Promise.all([firstRequestAborted.promise, firstSocketReleased.promise]);
      const [oldResult, newResult] = await Promise.all([oldLoad, newLoad]);

      expect(outcomes(oldResult).modelsDev).toEqual({
        kind: 'not-run',
        source: 'models-dev',
        contextKey: oldContexts.modelsDev,
        reason: 'superseded',
      });
      expect(oldResult.catalog).toBeNull();
      expect(newResult.catalog).toEqual(catalog);
      expect(outcomes(newResult).modelsDev).toMatchObject({ kind: 'fresh', origin: 'request' });
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('hydrates compatible disk readiness as stale evidence with its original observation time', async () => {
    const clock = createClock();
    const cachedAt = clock.now() - 30_000;
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: {
        contextKey: sourceContext('readiness'),
        fetchedAt: cachedAt,
        validatedAt: cachedAt + 1_000,
        generation: 4,
        requestId: 9,
        providers: [makeProvider()],
        cliTools: [makeCliTool({ installedVersion: 'disk-version' })],
      },
    });
    const deps = makeDeps({ now: clock.now, offline: true, sourceContexts: sourceContexts() });

    const result = await service.loadDetection({ deps, projectDir: tempDir });

    expect(result.cliTools[0]?.installedVersion).toBe('disk-version');
    expect(outcomes(result).readiness).toMatchObject({
      kind: 'stale',
      snapshot: {
        contextKey: sourceContext('readiness'),
        fetchedAt: cachedAt,
        stale: true,
      },
    });
  });

  it('does not hydrate a disk snapshot whose context no longer matches', async () => {
    await saveDetectionCache({
      projectDir: tempDir,
      snapshot: {
        contextKey: 'different-context-v1',
        fetchedAt: 1_700_000_000_000,
        validatedAt: 1_700_000_000_000,
        generation: 4,
        requestId: 9,
        providers: [makeProvider()],
        cliTools: [makeCliTool({ installedVersion: 'wrong-context' })],
      },
    });
    const deps = makeDeps({ offline: true });

    const result = await service.loadDetection({ deps, projectDir: tempDir });

    expect(result.cliTools).toEqual([]);
    expect(outcomes(result).readiness).toMatchObject({ kind: 'not-run', reason: 'offline' });
  });

  it.each([
    { name: 'v1 offline', version: 1, offline: true, expectedOutcome: 'not-run' },
    { name: 'v1 failed', version: 1, offline: false, expectedOutcome: 'failed' },
    { name: 'v2 offline', version: 2, offline: true, expectedOutcome: 'not-run' },
    { name: 'v2 failed', version: 2, offline: false, expectedOutcome: 'failed' },
  ] as const)(
    'scrubs a legacy private cache before the following readiness refresh is $name',
    async ({ version, offline, expectedOutcome }) => {
      const cacheDir = join(tempDir, SPLITBRIEF_DIR);
      const cachePath = join(cacheDir, 'detection-cache.json');
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, legacyPrivateCache(version), 'utf8');

      const deps = makeDeps({
        offline,
        sourceContexts: sourceContexts(),
        ...(offline
          ? {}
          : {
              detectAll: async () => {
                throw new Error('Readiness network failure.');
              },
            }),
      });
      const result = await service.loadDetection({ deps, projectDir: tempDir });
      await service.getPendingSave();

      expect(outcomes(result).readiness).toMatchObject({ kind: expectedOutcome });
      await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('keeps a prior in-memory success when the disk cache later becomes malformed', async () => {
    const deps = makeDeps();
    const first = await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    await writeFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'malformed', 'utf8');

    const result = await service.loadDetection({ deps, projectDir: tempDir });

    expect(result.cliTools[0]?.installedVersion).toBe(first.cliTools[0]?.installedVersion);
    expect(outcomes(result).readiness).toMatchObject({ kind: 'fresh', origin: 'snapshot' });
  });

  it('persists sanitized CLI catalog model rows without their connection context keys', async () => {
    const rememberedModelId = 'cli-catalog-remembered-model';
    const deps = makeDeps({
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => [
        {
          connection: {
            tool: 'codex',
            contextKey: 'opaque-cli-executable-context',
          },
          outcome: { kind: 'success', value: [{ id: rememberedModelId }] },
        },
      ],
    });

    const result = await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    const cache = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');

    expect(result.cliModels).toMatchObject([
      { outcome: { kind: 'success', value: [{ id: rememberedModelId }] } },
    ]);
    expect(cache).not.toContain('opaque-cli-executable-context');
    expect(JSON.parse(cache).cliCatalogs).toEqual([
      {
        tool: 'codex',
        models: [{ id: rememberedModelId }],
        probedAt: expect.any(Number),
      },
    ]);
  });

  it('keeps memory and disk catalogs equal across config changes on the same executable', async () => {
    const clock = createClock();
    const executable = {
      path: '/trusted/opencode',
      fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      executableIdentity: {
        canonicalPath: '/trusted/opencode',
        realPath: '/trusted/opencode',
        platformFileId: '1:2',
        fingerprint: `1:2:3:4:sha256:${'c'.repeat(64)}`,
        resolvedAt: 1,
      },
    };
    const initialConfig = makeConfig({
      planner: { kind: 'cli', tool: 'opencode', model: 'model-a' },
      reviewer: { kind: 'cli', tool: 'opencode', model: 'model-b' },
    });
    const changedConfig = makeConfig({
      planner: { kind: 'cli', tool: 'opencode', model: 'model-b' },
      reviewer: { kind: 'cli', tool: 'opencode', model: 'model-a' },
      implementer: { model: 'qwen2.5-coder:14b' },
    });
    const initialContexts = createProductionDetectionDeps({
      config: initialConfig,
      projectDir: tempDir,
    }).sourceContexts;
    const changedContexts = createProductionDetectionDeps({
      config: changedConfig,
      projectDir: tempDir,
    }).sourceContexts;
    expect(changedContexts.cliModels).not.toBe(initialContexts.cliModels);

    const steps = [
      {
        config: initialConfig,
        contexts: initialContexts,
        role: 'planner',
        ids: ['model-a', 'model-b'],
      },
      { config: changedConfig, contexts: changedContexts, role: 'reviewer', ids: ['model-a'] },
      { config: changedConfig, contexts: changedContexts, role: 'planner', ids: ['model-a'] },
    ] as const;
    for (const [index, step] of steps.entries()) {
      const context = projectRunnerDiscoveryContext({ config: step.config, role: step.role });
      const connection = scopedCliCatalogConnection({
        tool: 'opencode',
        authChannel: context.authChannel,
        executable,
      });
      const deps = makeDeps({
        now: clock.now,
        sourceContexts: step.contexts,
        discoverAllCliTools: async () => [
          { connection, outcome: { kind: 'success', value: step.ids.map((id) => ({ id })) } },
        ],
      });
      const request = modelCacheStore.beginRefresh({ contexts: step.contexts });
      const result = await service.refreshDetection({ deps, projectDir: tempDir });
      expect(modelCacheStore.publish({ result, request })).toBe(true);
      await service.getPendingSave();

      const runtime = modelCacheStore.getCliCatalogRuntime({ tool: 'opencode' });
      const disk = (await loadRememberedSnapshot(tempDir))?.cliCatalogs?.find(
        (catalog) => catalog.tool === 'opencode',
      );
      const expectedModels = (index === 2 ? ['model-a'] : ['model-a', 'model-b']).map((id) => ({
        id,
      }));
      expect(runtime).toMatchObject({
        state: index === 1 ? 'stale' : 'fresh',
        models: expectedModels,
      });
      expect(runtime?.missingOnce ?? []).toEqual(index === 1 ? ['model-b'] : []);
      expect(runtime?.models).toEqual(disk?.models);
      expect(runtime?.missingOnce ?? []).toEqual(disk?.missingOnce ?? []);
      expect(runtime?.fetchedAt).toBe(disk?.probedAt);
      expect(Object.keys(modelCacheStore.get().cliCatalogs)).toHaveLength(1);
      clock.advance(1_000);
    }
  });

  it('merges disk catalogs across restarts and preserves missing marks through failed reads', async () => {
    const clock = createClock();
    let read: ProbeOutcome<readonly DetectedModel[]> = {
      kind: 'success',
      value: [{ id: 'model-a' }, { id: 'model-b' }],
    };
    const deps = makeDeps({
      now: clock.now,
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => [
        { connection: { tool: 'codex', contextKey: 'codex-context' }, outcome: read },
        {
          connection: { tool: 'opencode', contextKey: 'opencode-context' },
          outcome: { kind: 'success', value: [{ id: 'untouched' }] },
        },
      ],
    });
    await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    const initialTime = clock.now();
    const steps = [
      {
        outcome: {
          kind: 'success',
          value: [{ id: 'model-c' }, { id: 'model-a', displayName: 'Updated A' }],
        },
        models: [{ id: 'model-c' }, { id: 'model-a', displayName: 'Updated A' }, { id: 'model-b' }],
        missingOnce: ['model-b'],
        complete: false,
      },
      {
        outcome: {
          kind: 'success',
          value: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-c' }],
        },
        models: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-c' }],
        missingOnce: [],
        complete: true,
      },
      {
        outcome: { kind: 'success', value: [{ id: 'model-c' }, { id: 'model-a' }] },
        models: [{ id: 'model-c' }, { id: 'model-a' }, { id: 'model-b' }],
        missingOnce: ['model-b'],
        complete: false,
      },
      {
        outcome: { kind: 'timeout' },
        models: [{ id: 'model-c' }, { id: 'model-a' }, { id: 'model-b' }],
        missingOnce: ['model-b'],
        complete: false,
      },
      {
        outcome: { kind: 'success', value: [{ id: 'model-a' }, { id: 'model-c' }] },
        models: [{ id: 'model-a' }, { id: 'model-c' }],
        missingOnce: [],
        complete: true,
      },
      {
        outcome: { kind: 'success', value: [] },
        models: [{ id: 'model-a' }, { id: 'model-c' }],
        missingOnce: ['model-a', 'model-c'],
        complete: false,
      },
      { outcome: { kind: 'success', value: [] }, models: [], missingOnce: [], complete: false },
    ] satisfies readonly {
      outcome: ProbeOutcome<readonly DetectedModel[]>;
      models: readonly DetectedModel[];
      missingOnce: readonly string[];
      complete: boolean;
    }[];
    let probedAt = initialTime;
    for (const step of steps) {
      clock.advance(1_000);
      read = step.outcome;
      const restarted = createDetectionService();
      await restarted.loadDetection({ deps, projectDir: tempDir });
      await restarted.getPendingSave();
      await restarted.shutdown();
      if (step.complete) probedAt = clock.now();
      const snapshot = await loadRememberedSnapshot(tempDir);
      const catalog = snapshot?.cliCatalogs?.find((entry) => entry.tool === 'codex');
      expect(catalog?.models).toEqual(step.models);
      expect(catalog?.missingOnce ?? []).toEqual(step.missingOnce);
      expect(catalog?.probedAt).toBe(probedAt);
      expect(snapshot?.cliCatalogs?.find((entry) => entry.tool === 'opencode')?.models).toEqual([
        { id: 'untouched' },
      ]);
    }
  });

  it('does not count a reused CLI snapshot as a second disk read', async () => {
    const clock = createClock();
    let models: readonly DetectedModel[] = [{ id: 'model-a' }, { id: 'model-b' }];
    const deps = makeDeps({
      now: clock.now,
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        clock.advance(1_000);
        return [
          {
            connection: { tool: 'codex', contextKey: 'codex-context' },
            outcome: { kind: 'success', value: models },
          },
        ];
      },
    });
    await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    models = [{ id: 'model-a' }];
    await service.refreshDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    const previous = await loadRememberedSnapshot(tempDir);
    expect(previous?.cliCatalogs?.[0]?.missingOnce).toEqual(['model-b']);
    clock.advance(5 * 60 * 1_000 - 500);
    const replayed = await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    expect(outcomes(replayed).readiness).toMatchObject({ kind: 'fresh', origin: 'request' });
    expect(outcomes(replayed).cliModels).toMatchObject({ kind: 'fresh', origin: 'snapshot' });
    expect((await loadRememberedSnapshot(tempDir))?.cliCatalogs).toEqual(previous?.cliCatalogs);
  });

  it('remembers a cold empty success without a confirmed probe time', async () => {
    await service.loadDetection({
      deps: makeDeps({
        discoverAllCliTools: async () => [
          {
            connection: { tool: 'codex', contextKey: 'codex-context' },
            outcome: { kind: 'success', value: [] },
          },
        ],
      }),
      projectDir: tempDir,
    });
    await service.getPendingSave();
    expect((await loadRememberedSnapshot(tempDir))?.cliCatalogs).toEqual([
      { tool: 'codex', models: [], probedAt: 0 },
    ]);
  });

  it('remembers whether the latest model list read named the project', async () => {
    const clock = createClock();
    let namesProject = true;
    const deps = makeDeps({
      now: clock.now,
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => [
        {
          connection: { tool: 'opencode', contextKey: 'opencode-context' },
          outcome: { kind: 'success', value: [{ id: 'lmstudio/qwen3' }] },
          ...(namesProject ? { namesProject } : {}),
        },
      ],
    });
    const savedNamesProject = async () => {
      clock.advance(1_000);
      const restarted = createDetectionService();
      await restarted.loadDetection({ deps, projectDir: tempDir });
      await restarted.getPendingSave();
      await restarted.shutdown();
      return (await loadRememberedSnapshot(tempDir))?.cliCatalogs?.[0]?.namesProject;
    };

    expect(await savedNamesProject()).toBe(true);
    namesProject = false;
    expect(await savedNamesProject()).toBeUndefined();
  });

  it('persists the provider auth facts a CLI probe read', async () => {
    const providerAuth = {
      kind: 'read',
      facts: [{ provider: 'Anthropic', source: 'oauth' }],
    } as const;
    const deps = makeDeps({
      sourceContexts: sourceContexts(),
      detectAll: async () => ({
        providers: [],
        cliTools: [{ ...makeCliTool(), providerAuth }],
      }),
    });

    await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    const cache = JSON.parse(
      await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8'),
    );

    expect(cache.cliTools[0].providerAuth).toEqual(providerAuth);
  });

  it('persists the fresh CLI probe of a new process even when readiness answers from disk', async () => {
    let probe = 0;
    const makeProbeDeps = () =>
      makeDeps({
        sourceContexts: sourceContexts(),
        discoverAllCliTools: async () => [
          {
            connection: { tool: 'codex', contextKey: 'probe-cli-context' },
            outcome: { kind: 'success', value: [{ id: `probe-model-${++probe}` }] },
          },
        ],
      });

    await service.loadDetection({ deps: makeProbeDeps(), projectDir: tempDir });
    await service.getPendingSave();

    const restarted = createDetectionService();
    await restarted.loadDetection({ deps: makeProbeDeps(), projectDir: tempDir });
    await restarted.getPendingSave();

    const cache = JSON.parse(
      await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8'),
    );
    expect(cache.cliCatalogs).toEqual([
      {
        tool: 'codex',
        models: [{ id: 'probe-model-2' }, { id: 'probe-model-1' }],
        missingOnce: ['probe-model-1'],
        probedAt: expect.any(Number),
      },
    ]);
  });

  it('keeps a remembered catalog, stale, when a later probe of that tool times out', async () => {
    const clock = createClock();
    const remembered = [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'moonshotai/kimi-k3' }];
    let outcome: 'success' | 'timeout' = 'success';
    const deps = makeDeps({
      now: clock.now,
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => [
        {
          connection: { tool: 'command-code', contextKey: 'command-code-context' },
          outcome:
            outcome === 'success' ? { kind: 'success', value: remembered } : { kind: 'timeout' },
        },
        {
          connection: { tool: 'codex', contextKey: 'codex-context' },
          outcome: { kind: 'success', value: [{ id: `codex-${outcome}` }] },
        },
      ],
    });

    await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    const probedAt = clock.now();
    clock.advance(60_000);
    outcome = 'timeout';
    const restarted = createDetectionService();
    const result = await restarted.refreshDetection({ deps, projectDir: tempDir });
    await restarted.getPendingSave();

    expect(result.cliModels).toMatchObject([
      { connection: { tool: 'command-code' }, outcome: { kind: 'timeout' } },
      { connection: { tool: 'codex' }, outcome: { kind: 'success' } },
    ]);
    const snapshot = await loadRememberedSnapshot(tempDir);
    expect(snapshot?.fetchedAt).toBe(probedAt + 60_000);
    expect(snapshot?.cliCatalogs).toEqual(
      expect.arrayContaining([
        {
          tool: 'codex',
          models: [{ id: 'codex-timeout' }, { id: 'codex-success' }],
          missingOnce: ['codex-success'],
          probedAt,
        },
        { tool: 'command-code', models: remembered, probedAt },
      ]),
    );
    expect(snapshot?.cliCatalogs).toHaveLength(2);
  });

  it('reuses the cli-models snapshot inside its TTL instead of re-probing', async () => {
    let probes = 0;
    const deps = makeDeps({
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => {
        probes += 1;
        return [
          {
            connection: { tool: 'codex', contextKey: 'ttl-cli-context' },
            outcome: { kind: 'success', value: [{ id: `ttl-model-${probes}` }] },
          },
        ];
      },
    });

    const first = await service.loadDetection({ deps, projectDir: tempDir });
    const second = await service.loadDetection({ deps, projectDir: tempDir });

    expect(probes).toBe(1);
    expect(outcomes(second).cliModels).toMatchObject({ kind: 'fresh', origin: 'snapshot' });
    expect(second.cliModels).toMatchObject([
      { outcome: { kind: 'success', value: [{ id: 'ttl-model-1' }] } },
    ]);
    expect(first.cliModels).toMatchObject([
      { outcome: { kind: 'success', value: [{ id: 'ttl-model-1' }] } },
    ]);
  });

  it('uses a soft TTL in memory and lets manual refresh bypass it without clearing last success', async () => {
    const clock = createClock();
    const deps = makeDeps({ now: clock.now });

    const first = await service.loadDetection({ deps });
    clock.advance(100);
    const automatic = await service.loadDetection({ deps });
    const beforeManual = automatic.cliTools[0]?.installedVersion;
    const manual = await service.refreshDetection({ deps });

    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(automatic).toMatchObject({
      outcomes: { readiness: { kind: 'fresh', origin: 'snapshot' } },
    });
    expect(beforeManual).toBe('gen-1');
    expect(manual.cliTools[0]?.installedVersion).toBe('gen-2');
    expect(outcomes(manual).readiness).toMatchObject({ kind: 'fresh', origin: 'request' });
  });

  it('keeps the last public catalog as stale after a failed manual refresh', async () => {
    let failure = false;
    const initialCatalog = {
      openai: {
        id: 'openai',
        models: { 'gpt-test': { id: 'gpt-test' } },
      },
    };
    const deps = makeDeps({
      fetchModelsDevCatalog: async () => {
        if (!failure) return modelsDevOutcome(initialCatalog);
        return {
          kind: 'stale',
          snapshot: {
            sourceUrl: 'https://models.dev/api.json',
            parserVersion: 'test-parser',
            catalog: initialCatalog,
            catalogState: 'populated',
            fetchedAt: 1_700_000_000_000,
            validatedAt: 1_700_000_000_000,
          },
          failure: {
            kind: 'http-error',
            message: 'Models.dev catalog request returned HTTP 500.',
          },
        };
      },
    });

    await service.loadDetection({ deps });
    failure = true;
    const refreshed = await service.refreshDetection({ deps });

    expect(refreshed.catalog).toEqual(initialCatalog);
    expect(outcomes(refreshed).modelsDev).toMatchObject({
      kind: 'stale',
      failure: {
        kind: 'http-error',
        message: 'Models.dev catalog request returned HTTP 500.',
      },
      snapshot: {
        stale: true,
        fetchedAt: 1_700_000_000_000,
        validatedAt: 1_700_000_000_000,
        error: { kind: 'request-failed', message: 'Models.dev catalog request returned HTTP 500.' },
      },
    });
  });

  it('invalidates explicitly without making manual refresh delete snapshots first', async () => {
    const deps = makeDeps();

    const first = await service.loadDetection({ deps, projectDir: tempDir });
    await service.getPendingSave();
    await service.invalidateDetection({ deps, projectDir: tempDir });
    const afterInvalidation = await service.loadDetection({ deps, projectDir: tempDir });

    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(afterInvalidation.cliTools[0]?.installedVersion).toBe('gen-2');
    expect(outcomes(afterInvalidation).readiness).toMatchObject({
      kind: 'fresh',
      origin: 'request',
    });
  });

  it('publishes each lane as it settles instead of behind the slowest one', async () => {
    const contexts = sourceContexts();
    const catalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { demo: { id: 'demo' } } },
    };
    const readinessGate = Promise.withResolvers<void>();
    const cliGate = Promise.withResolvers<void>();
    const modelsDevPublished = Promise.withResolvers<void>();
    const publishedLanes: string[] = [];
    let publishedCatalog: ModelsDevCatalog | undefined;
    const deps = makeDeps({
      sourceContexts: contexts,
      detectAll: async () => {
        await readinessGate.promise;
        return { providers: [makeProvider()], cliTools: [makeCliTool()] };
      },
      fetchModelsDevCatalog: async () => modelsDevOutcome(catalog),
      discoverAllCliTools: async () => {
        await cliGate.promise;
        return [];
      },
    });
    const request = detectionStore.beginRefresh({ contexts });

    const load = service.loadDetection({
      deps,
      onLane: (lane) => {
        publishedLanes.push(lane.lane);
        detectionStore.publishLane({ lane, request });
        if (lane.lane === 'modelsDev' && lane.outcome.kind === 'fresh') {
          publishedCatalog = lane.outcome.snapshot.value;
          modelsDevPublished.resolve();
        }
      },
    });
    await modelsDevPublished.promise;

    expect(publishedLanes).toEqual(['modelsDev']);
    expect(publishedCatalog).toBe(catalog);
    expect(modelCacheStore.getModelsDevCatalog()).toBe(catalog);
    expect(detectionStore.get().refresh.modelsDev).toMatchObject({
      outcome: 'fresh',
      refreshing: false,
    });
    expect(detectionStore.get().refresh.readiness).toMatchObject({
      outcome: 'uninitialized',
      refreshing: true,
    });
    expect(detectionStore.get().cliTools).toEqual([]);

    readinessGate.resolve();
    cliGate.resolve();
    const result = await load;
    expect(result.catalog).toBe(catalog);

    expect(publishedLanes[0]).toBe('modelsDev');
    expect([...publishedLanes].sort()).toEqual(['cliModels', 'modelsDev', 'readiness']);
    expect(detectionStore.get().cliTools).toHaveLength(1);
    expect(detectionStore.get().refresh.cliModels.refreshing).toBe(false);
  });

  it('persists the detection cache even when a lane listener throws', async () => {
    const deps = makeDeps({ sourceContexts: sourceContexts() });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await service.loadDetection({
      deps,
      projectDir: tempDir,
      onLane: () => {
        throw new Error('lane listener exploded');
      },
    });
    await service.getPendingSave();

    // Publication is best-effort notification. A store or UI listener must not
    // be able to reject the load and take `queueSave` down with it.
    expect(result.cliTools).toHaveLength(1);
    const cache = JSON.parse(
      await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8'),
    );
    expect(cache.cliTools).toHaveLength(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Could not show a tool check result'),
    );
    stderr.mockRestore();
  });

  it('replays already-settled lanes to a listener that joins a load in flight', async () => {
    const gate = Promise.withResolvers<void>();
    const modelsDevSettled = Promise.withResolvers<void>();
    const deps = makeDeps({
      sourceContexts: sourceContexts(),
      detectAll: async () => {
        await gate.promise;
        return { providers: [makeProvider()], cliTools: [makeCliTool()] };
      },
    });

    const first: string[] = [];
    const load = service.loadDetection({
      deps,
      onLane: (lane) => {
        first.push(lane.lane);
        if (lane.lane === 'modelsDev') modelsDevSettled.resolve();
      },
    });
    await modelsDevSettled.promise;

    const late: string[] = [];
    const joined = service.loadDetection({ deps, onLane: (lane) => late.push(lane.lane) });
    // Lanes are announced once. A deduped caller that arrives afterwards would
    // otherwise wait forever on a lane that has already spoken.
    expect(late).toContain('modelsDev');

    gate.resolve();
    await Promise.all([load, joined]);

    expect([...first].sort()).toEqual(['cliModels', 'modelsDev', 'readiness']);
    expect([...late].sort()).toEqual(['cliModels', 'modelsDev', 'readiness']);
  });

  it('lets a slower lane publish under a generation the faster lane already outran', async () => {
    const contexts = sourceContexts();
    const readinessGate = Promise.withResolvers<void>();
    const cliGate = Promise.withResolvers<void>();
    const modelsDevPublished = Promise.withResolvers<void>();
    const deps = makeDeps({
      sourceContexts: contexts,
      detectAll: async () => {
        await readinessGate.promise;
        return { providers: [makeProvider()], cliTools: [makeCliTool()] };
      },
      discoverAllCliTools: async () => {
        await cliGate.promise;
        return [];
      },
    });
    const request = detectionStore.beginRefresh({ contexts });

    const load = service.loadDetection({
      deps,
      onLane: (lane) => {
        detectionStore.publishLane({ lane, request });
        if (lane.lane === 'modelsDev') modelsDevPublished.resolve();
      },
    });
    await modelsDevPublished.promise;
    readinessGate.resolve();
    cliGate.resolve();
    await load;

    // One monotonic coordinator generation is shared across sources, so the
    // readiness lane carries a lower number than the models.dev lane that
    // settled first. A single global guard would drop readiness silently.
    const refresh = detectionStore.get().refresh;
    expect(refresh.readiness.generation).toBeLessThan(refresh.modelsDev.generation ?? 0);
    expect(refresh.readiness.outcome).toBe('fresh');
    expect(detectionStore.get().providers).toEqual([makeProvider()]);
    expect(detectionStore.get().cliTools).toHaveLength(1);
    expect(refresh.generation).toBe(refresh.cliModels.generation);
  });

  it('records no remote source invocation while offline and returns structured uninitialized refresh outcomes', async () => {
    const remoteSources: string[] = [];
    const offline = makeDeps({
      offline: true,
      detectAll: async () => {
        remoteSources.push('readiness');
        return { providers: [], cliTools: [] };
      },
      fetchModelsDevCatalog: async () => {
        remoteSources.push('models-dev');
        return modelsDevOutcome({});
      },
      discoverAllCliTools: async () => {
        remoteSources.push('cli-models');
        return [];
      },
    });

    const offlineResult = await service.loadDetection({ deps: offline });
    const neverLoaded = createDetectionService();
    const notRun = await neverLoaded.refreshDetection(undefined);

    expect(remoteSources).toEqual([]);
    expect(outcomes(offlineResult)).toMatchObject({
      readiness: { kind: 'not-run', reason: 'offline' },
      modelsDev: { kind: 'not-run', reason: 'offline' },
      cliModels: { kind: 'not-run', reason: 'offline' },
    });
    expect(outcomes(notRun)).toMatchObject({
      readiness: { kind: 'not-run', reason: 'uninitialized' },
      modelsDev: { kind: 'not-run', reason: 'uninitialized' },
      cliModels: { kind: 'not-run', reason: 'uninitialized' },
    });
  });
});
