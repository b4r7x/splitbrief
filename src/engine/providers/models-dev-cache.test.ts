import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import {
  loadModelsDevCatalogCache,
  refreshModelsDevCatalogCache,
  type ModelsDevCatalogCacheOptions,
} from './models-dev-cache.js';
import {
  MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES,
  MODELS_DEV_CATALOG_PARSER_VERSION,
  resolveModelsDevCatalogCachePath,
  resolveModelsDevUserCacheDir,
} from './models-dev-cache/store.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

interface PlannedResponse {
  readonly body?: string;
  readonly headers?: http.OutgoingHttpHeaders;
  readonly status: number;
  readonly waitForAbort?: boolean;
}

interface ObservedRequest {
  readonly headers: http.IncomingHttpHeaders;
  readonly url: string | undefined;
}

function catalog(modelId = 'model-a'): ModelsDevCatalog {
  return {
    'provider-a': {
      id: 'provider-a',
      name: 'Provider A',
      api: 'https://catalog.provider-a.example/v1',
      models: {
        [modelId]: {
          id: modelId,
          name: 'Model A',
          status: 'deprecated',
          release_date: '2025-02-01',
          last_updated: '2026-01-15',
          limit: { context: 200_000, input: 180_000, output: 32_768 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          tool_call: true,
          structured_output: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        },
      },
    },
  };
}

describe('models.dev user cache', () => {
  let cacheRoot: string;
  let cacheDir: string;
  let currentTime: number;
  let requests: ObservedRequest[];
  let responses: PlannedResponse[];
  let server: http.Server;
  let sourceUrl: string;

  function options(
    overrides: Partial<ModelsDevCatalogCacheOptions> = {},
  ): ModelsDevCatalogCacheOptions {
    return {
      cacheDir,
      sourceUrl,
      now: () => currentTime,
      mode: 'manual',
      ...overrides,
    };
  }

  function writeCachedCatalog(): void {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      resolveModelsDevCatalogCachePath(options()),
      JSON.stringify({
        version: 1,
        sourceUrl,
        parserVersion: MODELS_DEV_CATALOG_PARSER_VERSION,
        catalog: catalog(),
        fetchedAt: currentTime,
        validatedAt: currentTime,
      }),
    );
  }

  beforeEach(async () => {
    cacheRoot = createTempDir('models-dev-user-cache');
    cacheDir = join(cacheRoot, '.splitbrief', 'cache');
    currentTime = 1_700_000_000_000;
    requests = [];
    responses = [];
    server = http.createServer((request, response) => {
      requests.push({ headers: request.headers, url: request.url });
      const planned = responses.shift();
      if (planned === undefined) {
        response.writeHead(500);
        response.end();
        return;
      }
      if (planned.waitForAbort === true) return;
      response.writeHead(planned.status, planned.headers);
      response.end(planned.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    sourceUrl = `http://127.0.0.1:${address.port}/api.json`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTempDir(cacheRoot);
  });

  it('shares one deep-frozen catalog across concurrent cold reads and a refresh within TTL', async () => {
    writeCachedCatalog();

    const [first, second] = await Promise.all([
      loadModelsDevCatalogCache(options()),
      loadModelsDevCatalogCache(options()),
    ]);
    if (first === null || second === null) throw new Error('Expected cached snapshots.');

    expect(first.catalog).toEqual(catalog());
    expect(second).toBe(first);
    expect(second.catalog).toBe(first.catalog);
    const model = first.catalog['provider-a']?.models['model-a'];
    if (model?.limit === undefined) throw new Error('Expected a model with limits.');
    const limit = model.limit;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.catalog)).toBe(true);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(limit)).toBe(true);
    expect(() => {
      limit.context = 1;
    }).toThrow(TypeError);
    expect(limit.context).toBe(200_000);

    currentTime += 1_000;
    const refreshed = await refreshModelsDevCatalogCache(options({ mode: 'automatic' }));
    if (refreshed.kind !== 'cached') throw new Error('Expected a cached outcome within TTL.');
    expect(refreshed.snapshot).toBe(first);
    expect(refreshed.snapshot.catalog).toBe(first.catalog);
    expect(requests).toHaveLength(0);
  });

  it('does not remember concurrent corrupt reads and loads a repaired cache on the next read', async () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(resolveModelsDevCatalogCachePath(options()), '{invalid-json');

    expect(
      await Promise.all([
        loadModelsDevCatalogCache(options()),
        loadModelsDevCatalogCache(options()),
      ]),
    ).toEqual([null, null]);

    writeCachedCatalog();
    const repaired = await loadModelsDevCatalogCache(options());
    expect(repaired?.catalog).toEqual(catalog());
  });

  it('retries a missing cache and preserves a stale disk catalog after a failed automatic refresh', async () => {
    expect(await loadModelsDevCatalogCache(options())).toBeNull();
    writeCachedCatalog();
    const cached = await loadModelsDevCatalogCache(options());
    if (cached === null) throw new Error('Expected a repaired cache.');

    currentTime += 60 * 60 * 1_000;
    responses.push({ status: 500 });
    const stale = await refreshModelsDevCatalogCache(options({ mode: 'automatic' }));
    if (stale.kind !== 'stale') throw new Error('Expected a stale disk catalog.');
    expect(stale.failure.kind).toBe('http-error');
    expect(stale.snapshot).toBe(cached);
    expect(stale.snapshot.validatedAt).toBe(1_700_000_000_000);
    expect(requests).toHaveLength(1);
  });

  it('keeps catalog JSON parsing off the main thread for cold reads, responses, and pruning', async () => {
    writeCachedCatalog();
    const mainThreadParse = vi.spyOn(JSON, 'parse');
    const loaded = await loadModelsDevCatalogCache(options());
    expect(loaded?.catalog).toEqual(catalog());

    responses.push({ status: 200, body: JSON.stringify(catalog('replacement-model')) });
    const refreshed = await refreshModelsDevCatalogCache(options());
    expect(refreshed).toMatchObject({
      kind: 'fresh',
      snapshot: { catalog: catalog('replacement-model') },
    });
    expect(mainThreadParse.mock.calls.filter(([raw]) => raw.includes('"provider-a":{'))).toEqual(
      [],
    );
  });

  it('uses ETags without provider credentials and persists a 304 validation time', async () => {
    responses.push({
      status: 200,
      headers: { ETag: '"catalog-v1"', 'Content-Type': 'application/json' },
      body: JSON.stringify(catalog()),
    });
    const first = await refreshModelsDevCatalogCache(options());
    expect(first).toMatchObject({
      kind: 'fresh',
      snapshot: {
        etag: '"catalog-v1"',
        fetchedAt: currentTime,
        validatedAt: currentTime,
        catalogState: 'populated',
      },
    });
    expect(requests[0]?.url).toBe('/api.json');
    expect(requests[0]?.headers['if-none-match']).toBeUndefined();
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.headers['x-api-key']).toBeUndefined();

    currentTime += 1_000;
    responses.push({ status: 304, headers: { ETag: '"catalog-v1"' } });
    const revalidated = await refreshModelsDevCatalogCache(options());
    expect(revalidated).toMatchObject({
      kind: 'not-modified',
      snapshot: {
        etag: '"catalog-v1"',
        fetchedAt: 1_700_000_000_000,
        validatedAt: currentTime,
      },
    });
    expect(requests[1]?.headers['if-none-match']).toBe('"catalog-v1"');

    if (first.kind !== 'fresh' || revalidated.kind !== 'not-modified') {
      throw new Error('Expected a fresh catalog followed by revalidation.');
    }
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.catalog)).toBe(true);
    expect(Object.isFrozen(revalidated.snapshot)).toBe(true);
    expect(revalidated.snapshot).not.toBe(first.snapshot);
    expect(revalidated.snapshot.catalog).toBe(first.snapshot.catalog);

    const fromDisk = await loadModelsDevCatalogCache(options());
    expect(fromDisk).toMatchObject({
      catalog: catalog(),
      validatedAt: currentTime,
    });
    expect(fromDisk).toBe(revalidated.snapshot);
  });

  it('does not write the cache when aborted during 304 body cancellation', async () => {
    responses.push({ status: 200, body: JSON.stringify(catalog()) });
    await refreshModelsDevCatalogCache(options());
    const cachePath = resolveModelsDevCatalogCachePath(options());
    const before = readFileSync(cachePath, 'utf8');
    const cached = await loadModelsDevCatalogCache(options());
    currentTime += 1_000;
    const controller = new AbortController();
    const reason = new Error('Refresh cancelled');
    const response = new Response(null, { status: 304 });
    const cancel = vi.fn(async () => {
      await Promise.resolve();
      controller.abort(reason);
    });
    Object.defineProperty(response, 'body', { value: new ReadableStream({ cancel }) });

    await expect(
      refreshModelsDevCatalogCache(
        options({ signal: controller.signal, fetch: async () => response }),
      ),
    ).rejects.toBe(reason);

    expect(cancel).toHaveBeenCalledOnce();
    expect(readFileSync(cachePath, 'utf8')).toBe(before);
    expect(await loadModelsDevCatalogCache(options())).toEqual(cached);
  });

  it('uses the user-level path with owner-only modes and atomically replaces a valid catalog', async () => {
    responses.push({ status: 200, body: JSON.stringify(catalog('model-a')) });
    await expect(refreshModelsDevCatalogCache(options())).resolves.toMatchObject({
      kind: 'fresh',
      snapshot: { catalog: catalog('model-a') },
    });

    const cachePath = resolveModelsDevCatalogCachePath(options());
    expect(cachePath.startsWith(`${cacheDir}/`)).toBe(true);
    expect(
      resolveModelsDevCatalogCachePath(options({ parserVersion: 'models-dev-api-json-v2' })),
    ).not.toBe(cachePath);
    expect(resolveModelsDevUserCacheDir()).toBe(join(homedir(), SPLITBRIEF_DIR, 'cache'));
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);

    currentTime += 1_000;
    responses.push({ status: 200, body: JSON.stringify(catalog('model-b')) });
    const replacement = await refreshModelsDevCatalogCache(options());
    expect(replacement).toMatchObject({
      kind: 'fresh',
      snapshot: { catalog: catalog('model-b') },
    });
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
      catalog: catalog('model-b'),
      fetchedAt: currentTime,
      validatedAt: currentTime,
    });
    expect(readdirSync(cacheDir).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });

  itUnix(
    'retains only the newest validated parser records on disk across cache restarts',
    async () => {
      mkdirSync(cacheDir, { recursive: true });
      const unrelatedPath = join(cacheDir, 'unrelated-cache-sentinel.json');
      const symlinkTarget = join(cacheRoot, 'models-dev-symlink-target.json');
      const symlinkPath = resolveModelsDevCatalogCachePath(
        options({ parserVersion: 'models-dev-api-json-symlink-sentinel' }),
      );
      writeFileSync(unrelatedPath, 'unrelated cache entry');
      writeFileSync(symlinkTarget, 'symlink target remains untouched');
      symlinkSync(symlinkTarget, symlinkPath);

      const parserVersions = [
        'models-dev-api-json-v1',
        'models-dev-api-json-v2',
        'models-dev-api-json-v3',
        'models-dev-api-json-v4',
        'models-dev-api-json-v5',
        'models-dev-api-json-v6',
        'models-dev-api-json-v7',
      ];

      for (const parserVersion of parserVersions) {
        responses.push({ status: 200, body: JSON.stringify(catalog(parserVersion)) });
        await refreshModelsDevCatalogCache(options({ parserVersion }));
        currentTime += 1_000;
      }

      const persistedCacheFiles = readdirSync(cacheDir)
        .filter((entry) => entry.startsWith('models-dev-catalog-'))
        .filter((entry) => lstatSync(join(cacheDir, entry)).isFile())
        .sort();
      const expectedNewestFiles = parserVersions
        .slice(-4)
        .map((parserVersion) =>
          basename(resolveModelsDevCatalogCachePath(options({ parserVersion }))),
        )
        .sort();

      expect(persistedCacheFiles).toEqual(expectedNewestFiles);
      expect(persistedCacheFiles).toHaveLength(4);
      expect(readFileSync(unrelatedPath, 'utf8')).toBe('unrelated cache entry');
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(symlinkTarget, 'utf8')).toBe('symlink target remains untouched');

      vi.resetModules();
      const restartedCache = await import('./models-dev-cache.js');
      for (const parserVersion of parserVersions.slice(-4)) {
        await expect(
          restartedCache.loadModelsDevCatalogCache(options({ parserVersion })),
        ).resolves.toMatchObject({ parserVersion, catalog: catalog(parserVersion) });
      }
    },
  );

  it('uses the soft TTL automatically but lets a manual refresh revalidate', async () => {
    responses.push({ status: 200, body: JSON.stringify(catalog('model-a')) });
    await refreshModelsDevCatalogCache(options());

    currentTime += 1_000;
    const cached = await refreshModelsDevCatalogCache(options({ mode: 'automatic' }));
    expect(cached).toMatchObject({ kind: 'cached', snapshot: { catalog: catalog('model-a') } });
    expect(requests).toHaveLength(1);

    responses.push({ status: 200, body: JSON.stringify(catalog('model-b')) });
    const refreshed = await refreshModelsDevCatalogCache(options());
    expect(refreshed).toMatchObject({ kind: 'fresh', snapshot: { catalog: catalog('model-b') } });
    expect(requests).toHaveLength(2);
  });

  it('preserves the last good catalog across bounded transport and parsing failures', async () => {
    responses.push({ status: 200, body: JSON.stringify(catalog()) });
    const first = await refreshModelsDevCatalogCache(options());
    if (first.kind !== 'fresh') throw new Error('Expected a fresh catalog.');

    const failures: PlannedResponse[] = [
      {
        status: 200,
        headers: { 'Content-Length': String(MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES + 1) },
      },
      { status: 200, body: '{invalid-json' },
      {
        status: 200,
        body: JSON.stringify({ 'provider-a': { id: 'provider-a', models: { broken: {} } } }),
      },
      { status: 500 },
    ];
    const expectedKinds = ['payload-too-large', 'invalid-json', 'invalid-schema', 'http-error'];

    for (const [index, failure] of failures.entries()) {
      responses.push(failure);
      const result = await refreshModelsDevCatalogCache(options());
      expect(result).toMatchObject({
        kind: 'stale',
        failure: { kind: expectedKinds[index] },
        snapshot: { catalog: catalog(), catalogState: 'populated' },
      });
      if (result.kind !== 'stale') throw new Error('Expected a stale catalog after failure.');
      expect(result.snapshot).toBe(first.snapshot);
    }

    expect(
      JSON.parse(readFileSync(resolveModelsDevCatalogCachePath(options()), 'utf8')),
    ).toMatchObject({
      catalog: catalog(),
    });
  });

  it('keeps a valid empty catalog distinct from invalid data and timeout failures', async () => {
    responses.push({ status: 200, body: '{}' });
    const empty = await refreshModelsDevCatalogCache(options());
    expect(empty).toMatchObject({
      kind: 'fresh',
      snapshot: { catalog: {}, catalogState: 'empty' },
    });

    responses.push({ status: 200, body: '{invalid-json' });
    const invalid = await refreshModelsDevCatalogCache(options());
    expect(invalid).toMatchObject({
      kind: 'stale',
      failure: { kind: 'invalid-json' },
      snapshot: { catalog: {}, catalogState: 'empty' },
    });

    responses.push({ status: 200, waitForAbort: true });
    const timedOut = await refreshModelsDevCatalogCache(options({ timeoutMs: 25 }));
    expect(timedOut).toMatchObject({
      kind: 'stale',
      failure: { kind: 'timeout' },
      snapshot: { catalog: {}, catalogState: 'empty' },
    });
  });
});
