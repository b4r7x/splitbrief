import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../../core/types/config-options.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { detectionStore } from '../../stores/project/detection.js';
import { loadDetectionIntoStores } from './adapter.js';
import { createDetectionService } from './service.js';
import type { DetectionDeps, DetectionService } from './service.js';
import type { fetchModelsDevCatalog } from '../providers/models-dev.js';

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

function makeDeps(overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  return {
    detectAll: vi.fn().mockResolvedValue({ planners: [], implementers: [] }),
    fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
    discoverAllCliTools: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('loadDetectionIntoStores', () => {
  let service: DetectionService;

  beforeEach(() => {
    service = createDetectionService();
    detectionStore.reset();
    modelCacheStore.reset();
  });

  it('populates both planners and implementers from detectAll', async () => {
    const planners = [makePlanner({ tool: 'claude-code' }), makePlanner({ tool: 'codex', available: false })];
    const implementers = [makeImplementer({ provider: 'ollama' }), makeImplementer({ provider: 'lm-studio', available: false })];
    const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners, implementers }) });

    await loadDetectionIntoStores(deps, undefined, service);

    expect(deps.detectAll).toHaveBeenCalledOnce();
    const state = detectionStore.get();
    expect(state.planners).toBe(planners);
    expect(state.implementers).toBe(implementers);
  });

  describe('cache integration', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'diptych-detection-adapter-test-'));
      service = createDetectionService();
      detectionStore.reset();
    });

    afterEach(async () => {
      await service.getPendingSave();
      await rm(tempDir, { recursive: true, force: true });
    });

    it('uses cache on second call when projectDir is supplied', async () => {
      const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] }) });

      await loadDetectionIntoStores(deps, tempDir, service);
      expect(deps.detectAll).toHaveBeenCalledOnce();
      expect(deps.fetchModelsDevCatalog).toHaveBeenCalledOnce();
      expect(deps.discoverAllCliTools).toHaveBeenCalledOnce();

      await service.getPendingSave();

      await loadDetectionIntoStores(deps, tempDir, service);
      expect(deps.detectAll).toHaveBeenCalledTimes(1);
      expect(deps.fetchModelsDevCatalog).toHaveBeenCalledTimes(2);
      expect(deps.discoverAllCliTools).toHaveBeenCalledTimes(2);

      const state = detectionStore.get();
      expect(state.planners).toHaveLength(1);
      expect(state.implementers).toHaveLength(1);
    });

    it('hydrates models.dev and CLI discovery on cache hit', async () => {
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
        detectAll: vi.fn().mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] }),
        fetchModelsDevCatalog: vi.fn().mockResolvedValue(catalog) as typeof fetchModelsDevCatalog,
        discoverAllCliTools: vi.fn().mockResolvedValue({ opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] }),
      });

      await loadDetectionIntoStores(deps, tempDir, service);
      await service.getPendingSave();

      detectionStore.reset();
      modelCacheStore.reset();

      await loadDetectionIntoStores(deps, tempDir, service);

      expect(deps.detectAll).toHaveBeenCalledTimes(1);
      expect(deps.fetchModelsDevCatalog).toHaveBeenCalledTimes(2);
      expect(deps.discoverAllCliTools).toHaveBeenCalledTimes(2);
      expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
      expect(modelCacheStore.getProviderModels('opencode')).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);
    });

    it('always runs detection when projectDir is undefined (no cache scope)', async () => {
      const deps = makeDeps();
      await loadDetectionIntoStores(deps, undefined, service);
      await loadDetectionIntoStores(deps, undefined, service);

      expect(deps.detectAll).toHaveBeenCalledTimes(2);
    });

    it('invalidate() forces re-detection on next load', async () => {
      const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] }) });

      await loadDetectionIntoStores(deps, tempDir, service);
      expect(deps.detectAll).toHaveBeenCalledOnce();

      await service.invalidateDetection(tempDir);

      await loadDetectionIntoStores(deps, tempDir, service);
      expect(deps.detectAll).toHaveBeenCalledTimes(2);
    });
  });
});
