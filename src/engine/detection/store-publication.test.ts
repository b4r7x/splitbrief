import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { ProviderDetection } from '../../core/discovery/detection.js';
import type { DetectionLanePublication } from './lane-channel.js';
import type {
  DetectionDeps,
  DetectionRefreshOutcomes,
  DetectionService,
  DetectionServiceResult,
  ResolvedDetectionSourceContexts,
} from './service.js';
import { createProductionDetectionDeps } from './deps.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import {
  detectionContextsForCurrentConfig,
  loadDetectionForCurrentConfig,
  refreshDetectionForCurrentConfig,
  type CurrentDetectionConfig,
  type DetectionPublicationPort,
} from './store-publication.js';

function current(
  config: CurrentDetectionConfig['config'],
  projectDir: string,
): CurrentDetectionConfig {
  return { config, projectDir };
}

function freshResult(providers: ProviderDetection[] = []): DetectionServiceResult {
  return { providers, cliTools: [], catalog: {}, cliModels: [] };
}

function declaredContexts(deps: DetectionDeps): ResolvedDetectionSourceContexts {
  const contexts = deps.sourceContexts;
  return {
    readiness: contexts?.readiness ?? 'missing-readiness-context',
    modelsDev: contexts?.modelsDev ?? 'missing-models-dev-context',
    cliModels: contexts?.cliModels ?? 'missing-cli-models-context',
  };
}

/** Mirrors what the real service announces per lane while a load is in flight. */
function settledLanes(
  result: DetectionServiceResult,
  contexts: ResolvedDetectionSourceContexts,
): DetectionLanePublication[] {
  const stamp = { generation: 1, requestId: 1, fetchedAt: 100, validatedAt: 100, stale: false };
  return [
    {
      lane: 'readiness',
      outcome: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'readiness',
          contextKey: contexts.readiness,
          ...stamp,
          value: { providers: result.providers, cliTools: result.cliTools },
        },
      },
    },
    {
      lane: 'modelsDev',
      outcome:
        result.catalog === null
          ? {
              kind: 'not-run',
              source: 'models-dev',
              contextKey: contexts.modelsDev,
              reason: 'uninitialized',
            }
          : {
              kind: 'fresh',
              origin: 'request',
              snapshot: {
                source: 'models-dev',
                contextKey: contexts.modelsDev,
                ...stamp,
                value: result.catalog,
              },
            },
    },
    {
      lane: 'cliModels',
      outcome: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'cli-models',
          contextKey: contexts.cliModels,
          ...stamp,
          value: result.cliModels,
        },
      },
    },
  ];
}

function allFailedResult(deps: DetectionDeps): DetectionServiceResult {
  const contextKeys = declaredContexts(deps);
  const outcomes: DetectionRefreshOutcomes = {
    readiness: {
      kind: 'failed',
      source: 'readiness',
      contextKey: contextKeys.readiness,
      generation: 1,
      requestId: 1,
      checkedAt: 1,
      error: { kind: 'request-failed', message: 'Runner readiness refresh failed.' },
    },
    modelsDev: {
      kind: 'failed',
      source: 'models-dev',
      contextKey: contextKeys.modelsDev,
      generation: 1,
      requestId: 1,
      checkedAt: 1,
      failure: { kind: 'request-failed', message: 'Models.dev catalog request failed.' },
    },
    cliModels: {
      kind: 'failed',
      source: 'cli-models',
      contextKey: contextKeys.cliModels,
      generation: 1,
      requestId: 1,
      checkedAt: 1,
      error: { kind: 'request-failed', message: 'CLI model discovery refresh failed.' },
    },
  };
  return { providers: [], cliTools: [], catalog: null, cliModels: [], generation: 1, outcomes };
}

function publicationRecorder(): {
  readonly publication: DetectionPublicationPort;
  readonly began: ResolvedDetectionSourceContexts[];
  readonly publishedLanes: DetectionLanePublication['lane'][];
} {
  const began: ResolvedDetectionSourceContexts[] = [];
  const publishedLanes: DetectionLanePublication['lane'][] = [];
  return {
    publication: {
      beginRefresh: (input) => {
        began.push(input.contexts);
        return detectionStore.beginRefresh(input);
      },
      publishLane: (input) => {
        const published = detectionStore.publishLane(input);
        if (published) publishedLanes.push(input.lane.lane);
        return published;
      },
      publish: (input) => detectionStore.publish(input),
    },
    began,
    publishedLanes,
  };
}

function recordingService(input: {
  readonly load?: (deps: DetectionDeps) => Promise<DetectionServiceResult>;
  readonly refresh?: (deps: DetectionDeps) => Promise<DetectionServiceResult>;
}): {
  readonly service: DetectionService;
  readonly received: DetectionDeps[];
} {
  const received: DetectionDeps[] = [];
  return {
    service: {
      loadDetection: async ({ deps, onLane }) => {
        received.push(deps);
        const result = input.load === undefined ? freshResult() : await input.load(deps);
        if (onLane !== undefined) {
          for (const lane of settledLanes(result, declaredContexts(deps))) onLane(lane);
        }
        return result;
      },
      refreshDetection: async (refreshInput) => {
        if (refreshInput === undefined) return freshResult();
        const { deps } = refreshInput;
        received.push(deps);
        return input.refresh === undefined ? freshResult() : input.refresh(deps);
      },
    },
    received,
  };
}

function ollamaProvider(modelId: string): ProviderDetection {
  return {
    provider: 'ollama',
    available: true,
    isLocal: false,
    models: [{ id: modelId }],
  };
}

describe('store publication from current configuration', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('constructs current production dependencies internally before publishing startup detection', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://gateway.current.example/v1',
        apiKey: 'current-private-key',
        model: 'gpt-5.4',
      },
    });
    const state = current(config, '/projects/current');
    const { publication, began, publishedLanes } = publicationRecorder();
    const { service, received } = recordingService({
      load: async () => freshResult([ollamaProvider('current-private-model')]),
    });

    await loadDetectionForCurrentConfig({ service, publication, current: state });

    expect(received).toHaveLength(1);
    expect(received[0]?.sourceContexts).toEqual(detectionContextsForCurrentConfig(state));
    expect(began).toEqual([detectionContextsForCurrentConfig(state)]);
    expect(publishedLanes).toEqual(['readiness', 'modelsDev', 'cliModels']);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual([{ id: 'current-private-model' }]);
  });

  it('rejects executable config-A closure relabeling before publication begins', async () => {
    const configA = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://gateway.a.example/v1',
        apiKey: 'private-a',
        model: 'gpt-5.4',
      },
    });
    const configB = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://gateway.b.example/v1',
        apiKey: 'private-b',
        model: 'gpt-5.4',
      },
    });
    const stateA = current(configA, '/projects/a');
    const stateB = current(configB, '/projects/b');
    const forgedConfigADependencies = {
      ...createProductionDetectionDeps(stateA),
      sourceContexts: detectionContextsForCurrentConfig(stateB),
    };
    const { publication, began } = publicationRecorder();
    const { service, received } = recordingService({
      refresh: async () => freshResult([ollamaProvider('private-from-a')]),
    });
    const launderingCurrent = { ...stateB, deps: forgedConfigADependencies };
    const launderingAttempt = {
      service,
      publication,
      getCurrent: () => launderingCurrent,
    };

    const summary = await refreshDetectionForCurrentConfig(launderingAttempt);

    expect(summary).toMatchObject({ status: 'uninitialized', published: false });
    expect(began).toEqual([]);
    expect(received).toEqual([]);
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });

  it('reports a first-ever all-lane failure without publishing invented last-good data', async () => {
    const config = makeConfig();
    const state = current(config, '/projects/first-failure');
    const { publication } = publicationRecorder();
    const { service } = recordingService({
      refresh: async (deps) => allFailedResult(deps),
    });

    const summary = await refreshDetectionForCurrentConfig({
      service,
      publication,
      getCurrent: () => state,
    });

    expect(summary).toMatchObject({ status: 'failed', published: true });
    expect(detectionStore.get().providers).toEqual([]);
    expect(detectionStore.get().cliTools).toEqual([]);
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('keeps the newest same-context manual publication and reports the earlier one as superseded', async () => {
    const state = current(makeConfig(), '/projects/same-context');
    const result = Promise.withResolvers<DetectionServiceResult>();
    const { publication } = publicationRecorder();
    const { service } = recordingService({ refresh: async () => result.promise });

    const first = refreshDetectionForCurrentConfig({
      service,
      publication,
      getCurrent: () => state,
    });
    const second = refreshDetectionForCurrentConfig({
      service,
      publication,
      getCurrent: () => state,
    });
    result.resolve(freshResult());

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'superseded', published: false },
      { status: 'fresh', published: true },
    ]);
  });

  it('does not let a delayed config-A result overwrite current config-B private membership', async () => {
    const configA = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://gateway.a.example/v1',
        apiKey: 'private-a',
        model: 'gpt-5.4',
      },
    });
    const configB = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://gateway.b.example/v1',
        apiKey: 'private-b',
        model: 'gpt-5.4',
      },
    });
    const stateA = current(configA, '/projects/a');
    const stateB = current(configB, '/projects/b');
    const contextsA = detectionContextsForCurrentConfig(stateA);
    const pendingA = Promise.withResolvers<DetectionServiceResult>();
    const { publication } = publicationRecorder();
    const { service } = recordingService({
      refresh: async (deps) =>
        deps.sourceContexts?.readiness === contextsA.readiness
          ? pendingA.promise
          : freshResult([ollamaProvider('private-from-b')]),
    });

    const oldRefresh = refreshDetectionForCurrentConfig({
      service,
      publication,
      getCurrent: () => stateA,
    });
    const currentRefresh = await refreshDetectionForCurrentConfig({
      service,
      publication,
      getCurrent: () => stateB,
    });
    pendingA.resolve(freshResult([ollamaProvider('private-from-a')]));
    const oldSummary = await oldRefresh;

    expect(currentRefresh).toMatchObject({ status: 'fresh', published: true });
    expect(oldSummary).toMatchObject({ status: 'superseded', published: false });
    expect(modelCacheStore.getProviderModels('ollama')).toEqual([{ id: 'private-from-b' }]);
  });
});
