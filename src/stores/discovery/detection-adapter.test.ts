import { beforeEach, describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { hydrateDetectionIntoStores } from './detection-adapter.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from '../project/detection.js';

const contexts = {
  readiness: 'adapter-hydration:readiness',
  modelsDev: 'adapter-hydration:models-dev',
  cliModels: 'adapter-hydration:cli-models',
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
