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

  it('hydrates only cache data and preserves its original stale observation metadata', () => {
    hydrateDetectionIntoStores({
      detection: detectionStore,
      contexts,
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
        generation: 3,
        readiness: {
          outcome: 'stale',
          fetchedAt: 100,
          validatedAt: 200,
          requestId: 4,
        },
      },
    });
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
