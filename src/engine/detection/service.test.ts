import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { CliReadinessFacts } from '../../core/schemas/readiness.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { detectionContextKey } from './coordinator.js';
import { saveDetectionCache } from './cache.js';
import type { ModelsDevCatalogCacheOutcome } from '../providers/models-dev-cache.js';
import { fetchModelsDevCatalogWithCache } from '../providers/models-dev.js';
import {
  createDetectionService,
  type DetectionDeps,
  type DetectionRefreshOutcomes,
  type DetectionSourceContexts,
  type DetectionServiceResult,
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
      catalog,
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

function sourceContexts(): DetectionSourceContexts {
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
          provider: 'openai',
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
        provider: 'openai',
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
      runner: `${source}:planner:claude-code:implementer:openai`,
      authChannel: `${input.authChannel}:api-key`,
      endpointOrigin: `${input.endpointOrigin}:https://api.openai.example`,
      credentialDomain: `${input.credentialDomain}:env:OPENAI_API_KEY`,
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-detection-service-test-'));
    service = createDetectionService();
  });

  afterEach(async () => {
    await service.getPendingSave();
    await rm(tempDir, { recursive: true, force: true });
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
            role: 'planner',
            tool: 'opencode',
            contextKey: 'service-opencode-catalog',
          },
          outcome: { kind: 'success', value: [{ id: 'anthropic/claude-sonnet-4.6' }] },
        },
      ],
    });

    const first = await service.loadDetection(deps, tempDir);
    await service.getPendingSave();
    const second = await service.loadDetection(deps, tempDir);

    expect(first).toMatchObject({
      catalog,
      cliModels: [
        {
          connection: {
            role: 'planner',
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

    const first = await service.loadDetection(deps, '/projects/alpha');
    contexts = projectSourceContexts({
      projectDir: '/projects/bravo',
      authChannel: 'api-key',
      endpointOrigin: 'https://gateway.bravo.example',
      credentialDomain: 'env:BRAVO_API_KEY',
      configGeneration: 'bravo-config',
    });
    const second = await service.loadDetection(deps, '/projects/bravo');

    expect(first.cliTools[0]?.installedVersion).toBe('observation-1');
    expect(second.cliTools[0]?.installedVersion).toBe('observation-2');
    expect(observations).toBe(2);
    expect(JSON.stringify(second)).not.toContain('sk-test-private-credential');
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

      const first = await service.loadDetection(deps);
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

      const oldLoad = service.loadDetection(createSupersessionDeps(oldContexts), tempDir);
      await firstRequest.promise;
      const newLoad = service.loadDetection(createSupersessionDeps(newContexts), tempDir);

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

    const result = await service.loadDetection(deps, tempDir);

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

    const result = await service.loadDetection(deps, tempDir);

    expect(result.cliTools).toEqual([]);
    expect(outcomes(result).readiness).toMatchObject({ kind: 'not-run', reason: 'offline' });
  });

  it.each([
    { name: 'v1 offline', version: 1, offline: true, expectedOutcome: 'not-run' },
    { name: 'v1 failed', version: 1, offline: false, expectedOutcome: 'failed' },
    { name: 'v2 offline', version: 2, offline: true, expectedOutcome: 'not-run' },
    { name: 'v2 failed', version: 2, offline: false, expectedOutcome: 'failed' },
  ] as const)('scrubs a legacy private cache before the following readiness refresh is $name', async ({
    version,
    offline,
    expectedOutcome,
  }) => {
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
    const result = await service.loadDetection(deps, tempDir);
    await service.getPendingSave();

    expect(outcomes(result).readiness).toMatchObject({ kind: expectedOutcome });
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a prior in-memory success when the disk cache later becomes malformed', async () => {
    const deps = makeDeps();
    const first = await service.loadDetection(deps, tempDir);
    await service.getPendingSave();
    await writeFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'malformed', 'utf8');

    const result = await service.loadDetection(deps, tempDir);

    expect(result.cliTools[0]?.installedVersion).toBe(first.cliTools[0]?.installedVersion);
    expect(outcomes(result).readiness).toMatchObject({ kind: 'fresh', origin: 'snapshot' });
  });

  it('keeps scoped CLI catalog inventories in memory and excludes their model data from disk cache', async () => {
    const privateModelId = 'cli-catalog-private-model-canary';
    const deps = makeDeps({
      sourceContexts: sourceContexts(),
      discoverAllCliTools: async () => [
        {
          connection: {
            role: 'planner',
            tool: 'codex',
            contextKey: 'opaque-cli-executable-context',
          },
          outcome: { kind: 'success', value: [{ id: privateModelId }] },
        },
      ],
    });

    const result = await service.loadDetection(deps, tempDir);
    await service.getPendingSave();
    const cache = await readFile(join(tempDir, SPLITBRIEF_DIR, 'detection-cache.json'), 'utf8');

    expect(result.cliModels).toMatchObject([
      { outcome: { kind: 'success', value: [{ id: privateModelId }] } },
    ]);
    expect(cache).not.toContain(privateModelId);
    expect(cache).not.toContain('opaque-cli-executable-context');
  });

  it('uses a soft TTL in memory and lets manual refresh bypass it without clearing last success', async () => {
    const clock = createClock();
    const deps = makeDeps({ now: clock.now });

    const first = await service.loadDetection(deps);
    clock.advance(100);
    const automatic = await service.loadDetection(deps);
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

    await service.loadDetection(deps);
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

    const first = await service.loadDetection(deps, tempDir);
    await service.getPendingSave();
    await service.invalidateDetection({ deps, projectDir: tempDir });
    const afterInvalidation = await service.loadDetection(deps, tempDir);

    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(afterInvalidation.cliTools[0]?.installedVersion).toBe('gen-2');
    expect(outcomes(afterInvalidation).readiness).toMatchObject({
      kind: 'fresh',
      origin: 'request',
    });
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
        return {};
      },
      discoverAllCliTools: async () => {
        remoteSources.push('cli-models');
        return [];
      },
    });

    const offlineResult = await service.loadDetection(offline);
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
