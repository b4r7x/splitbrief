import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../../core/discovery/detection.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from '../project/detection.js';
import { loadDetectionIntoStores, refreshDetectionStores } from './detection-adapter.js';
import type { DetectionDeps, DetectionServiceResult } from '../../engine/detection/service.js';
import { createDetectionService } from '../../engine/detection/service.js';

const makePlanner = (overrides?: Partial<PlannerDetection>): PlannerDetection => ({
  tool: 'claude-code',
  type: 'cli',
  available: true,
  ...overrides,
});

const makeImplementer = (overrides?: Partial<ProviderDetection>): ProviderDetection => ({
  provider: 'ollama',
  available: true,
  isLocal: true,
  ...overrides,
});

describe('loadDetectionIntoStores', () => {
  beforeEach(() => {
    detectionStore.reset();
    modelCacheStore.reset();
  });

  it('populates both planners and implementers from detectAll', async () => {
    const planners = [
      makePlanner({ tool: 'claude-code' }),
      makePlanner({ tool: 'codex', available: false }),
    ];
    const implementers = [
      makeImplementer({ provider: 'ollama' }),
      makeImplementer({ provider: 'lm-studio', available: false }),
    ];
    const deps: DetectionDeps = {
      detectAll: async () => ({ planners, implementers }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };
    const fixedResult: DetectionServiceResult = {
      detection: { planners, implementers },
      catalog: null,
      cliModels: {},
    };
    const loadDetection = vi.fn().mockResolvedValue(fixedResult);
    const service = {
      loadDetection,
      refreshDetection: vi.fn(),
      invalidateDetection: vi.fn(),
    };

    await loadDetectionIntoStores(service, deps, detectionStore, undefined);

    const state = detectionStore.get();
    expect(state.planners).toEqual(planners);
    expect(state.implementers).toEqual(implementers);
  });

  it('forwards projectDir and applies the service result to stores', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'splitbrief-detection-adapter-forward-'));
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
    const planners = [makePlanner({ tool: 'claude-code', version: 'service-fixed' })];
    const implementers = [makeImplementer({ provider: 'ollama' })];
    const fixedResult: DetectionServiceResult = {
      detection: { planners, implementers },
      catalog,
      cliModels: { opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] },
    };
    const deps: DetectionDeps = {
      detectAll: vi.fn(),
      fetchModelsDevCatalog: vi.fn(),
      discoverAllCliTools: vi.fn(),
    };
    const loadDetection = vi.fn().mockResolvedValue(fixedResult);
    const service = {
      loadDetection,
      refreshDetection: vi.fn(),
      invalidateDetection: vi.fn(),
    };

    await loadDetectionIntoStores(service, deps, detectionStore, projectDir);

    expect(loadDetection).toHaveBeenCalledWith(deps, projectDir);
    expect(detectionStore.get().planners).toEqual(planners);
    expect(detectionStore.get().implementers).toEqual(implementers);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
    expect(modelCacheStore.getProviderModels('opencode')).toEqual([
      { id: 'anthropic/claude-sonnet-4.6' },
    ]);

    await rm(projectDir, { recursive: true, force: true });
  });
});

describe('refreshDetectionStores', () => {
  let service: ReturnType<typeof createDetectionService>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-refresh-detection-test-'));
    service = createDetectionService();
    detectionStore.reset();
    modelCacheStore.reset();
  });

  afterEach(async () => {
    await service.getPendingSave();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('updates detectionStore and modelCacheStore from fresh detection (regression: /refresh must apply results)', async () => {
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
    const cliModels = { opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] };

    let detectCalls = 0;
    const deps: DetectionDeps = {
      detectAll: async () => {
        detectCalls++;
        return {
          planners: [makePlanner({ tool: 'claude-code', version: `refresh-gen-${detectCalls}` })],
          implementers: [makeImplementer({ provider: 'ollama' })],
        };
      },
      fetchModelsDevCatalog: vi.fn().mockResolvedValue(catalog),
      discoverAllCliTools: vi.fn().mockResolvedValue(cliModels),
    };

    await service.loadDetection(deps, tempDir);
    await service.getPendingSave();

    detectionStore.reset();
    modelCacheStore.reset();
    expect(detectionStore.get().planners).toEqual([]);

    await refreshDetectionStores(service, detectionStore, tempDir);

    const state = detectionStore.get();
    expect(state.planners.length).toBe(1);
    expect(state.planners[0]?.version).toBe('refresh-gen-2');
    expect(state.implementers.length).toBe(1);
    expect(state.implementers[0]?.provider).toBe('ollama');
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
    expect(modelCacheStore.getProviderModels('opencode')).toEqual(cliModels.opencode);
  });

  it('invalidates model cache before applying fresh results', async () => {
    const deps: DetectionDeps = {
      detectAll: async () => ({
        planners: [makePlanner()],
        implementers: [makeImplementer()],
      }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await service.loadDetection(deps, tempDir);
    modelCacheStore.setProviderModels('ollama', [{ id: 'stale-model' }]);

    await refreshDetectionStores(service, detectionStore, tempDir);

    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });
});
