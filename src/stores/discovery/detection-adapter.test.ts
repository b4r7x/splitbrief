import { beforeEach, describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import {
  hydrateDetectionIntoStores,
  hydrateModelsDevCatalogIntoStores,
} from './detection-adapter.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from '../project/detection.js';
import type { ModelsDevCatalogSnapshot } from '../../engine/providers/models-dev-cache.js';

const contexts = {
  readiness: 'adapter-hydration:readiness',
  modelsDev: 'adapter-hydration:models-dev',
  cliModels: 'adapter-hydration:cli-models',
};

const catalogSnapshot: ModelsDevCatalogSnapshot = {
  sourceUrl: 'https://models.dev/api.json',
  parserVersion: 'models-dev-api-json-v1',
  catalog: { anthropic: { id: 'anthropic', models: { 'claude-opus-5': { id: 'claude-opus-5' } } } },
  catalogState: 'populated',
  fetchedAt: 1_700_000_000_000,
  validatedAt: 1_700_000_000_500,
};

describe('hydrateDetectionIntoStores', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('hydrates only cache data and preserves its original stale observation timestamps', () => {
    hydrateDetectionIntoStores({
      detection: detectionStore,
      contexts,
      foreignContext: false,
      snapshot: {
        contextKey: contexts.readiness,
        fetchedAt: 100,
        validatedAt: 200,
        generation: 3,
        requestId: 4,
        providers: [{ provider: 'ollama', available: true, isLocal: true }],
        cliTools: [cliDetectionFor('ready', 'codex')],
      },
    });

    expect(detectionStore.get()).toMatchObject({
      providers: [{ provider: 'ollama' }],
      cliTools: [{ tool: 'codex' }],
      refresh: {
        generation: 0,
        readiness: {
          outcome: 'stale',
          fetchedAt: 100,
          validatedAt: 200,
          requestId: 0,
        },
      },
    });
  });

  it('drops lane authority for a matching-context record too', () => {
    // The context matches, but the persisted generation still belongs to the
    // process that wrote it, and this one counts its own lanes from 1.
    hydrateDetectionIntoStores({
      detection: detectionStore,
      contexts,
      foreignContext: false,
      snapshot: {
        contextKey: contexts.readiness,
        fetchedAt: 100,
        validatedAt: 200,
        generation: 3,
        requestId: 4,
        providers: [],
        cliTools: [cliDetectionFor('ready', 'codex', { installedVersion: '0.40.0' })],
      },
    });

    const request = detectionStore.beginRefresh({ contexts });
    const landed = detectionStore.publishLane({
      request,
      lane: {
        lane: 'readiness',
        outcome: {
          kind: 'fresh',
          origin: 'request',
          snapshot: {
            source: 'readiness',
            contextKey: contexts.readiness,
            generation: 1,
            requestId: 1,
            fetchedAt: 300,
            validatedAt: 300,
            stale: false,
            value: {
              providers: [],
              cliTools: [cliDetectionFor('ready', 'codex', { installedVersion: '9.9.9' })],
            },
          },
        },
      },
    });

    expect(landed).toBe(true);
    expect(detectionStore.get().cliTools).toMatchObject([{ installedVersion: '9.9.9' }]);
  });

  it('does not hydrate cache data under a different active context', () => {
    detectionStore.beginRefresh({ contexts });

    hydrateDetectionIntoStores({
      detection: detectionStore,
      contexts: {
        readiness: 'foreign:readiness',
        modelsDev: 'foreign:models-dev',
        cliModels: 'foreign:cli-models',
      },
      foreignContext: true,
      snapshot: {
        contextKey: 'foreign:readiness',
        fetchedAt: 100,
        validatedAt: 200,
        generation: 3,
        requestId: 4,
        providers: [{ provider: 'ollama', available: true, isLocal: true }],
        cliTools: [],
      },
    });

    expect(detectionStore.get().providers).toEqual([]);
  });

  it('drops lane authority for a record written under a foreign config context', () => {
    // A fresh process counts its lanes from 1, so a remembered generation of 3
    // would outrank every lane the startup refresh lands.
    hydrateDetectionIntoStores({
      detection: detectionStore,
      contexts,
      foreignContext: true,
      snapshot: {
        contextKey: 'someone-elses-context',
        fetchedAt: 100,
        validatedAt: 200,
        generation: 3,
        requestId: 4,
        providers: [{ provider: 'ollama', available: true, isLocal: true }],
        cliTools: [cliDetectionFor('ready', 'codex', { installedVersion: '0.40.0' })],
      },
    });

    expect(detectionStore.get().refresh).toMatchObject({
      generation: 0,
      readiness: { outcome: 'stale', generation: 0, requestId: 0, fetchedAt: 100 },
    });

    const request = detectionStore.beginRefresh({ contexts });
    const landed = detectionStore.publishLane({
      request,
      lane: {
        lane: 'readiness',
        outcome: {
          kind: 'fresh',
          origin: 'request',
          snapshot: {
            source: 'readiness',
            contextKey: contexts.readiness,
            generation: 1,
            requestId: 1,
            fetchedAt: 300,
            validatedAt: 300,
            stale: false,
            value: {
              providers: [],
              cliTools: [cliDetectionFor('ready', 'codex', { installedVersion: '9.9.9' })],
            },
          },
        },
      },
    });

    expect(landed).toBe(true);
    expect(detectionStore.get().cliTools).toMatchObject([{ installedVersion: '9.9.9' }]);
    expect(detectionStore.get().refresh.readiness).toMatchObject({
      outcome: 'fresh',
      refreshing: false,
      generation: 1,
    });
  });
});

describe('hydrateModelsDevCatalogIntoStores', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('seeds the catalog and marks the lane remembered with the snapshot fetchedAt', () => {
    expect(
      hydrateModelsDevCatalogIntoStores({ cache: modelCacheStore, snapshot: catalogSnapshot }),
    ).toBe(true);

    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalogSnapshot.catalog);
    expect(modelCacheStore.get()).toMatchObject({
      modelsDevFetchedAt: catalogSnapshot.fetchedAt,
      refresh: {
        modelsDev: {
          outcome: 'stale',
          fetchedAt: catalogSnapshot.fetchedAt,
          validatedAt: catalogSnapshot.validatedAt,
          error: null,
        },
      },
    });
  });

  it('seeds independently of the detection contexts a refresh is running under', () => {
    detectionStore.beginRefresh({ contexts });

    expect(
      hydrateModelsDevCatalogIntoStores({ cache: modelCacheStore, snapshot: catalogSnapshot }),
    ).toBe(true);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalogSnapshot.catalog);
  });
});
