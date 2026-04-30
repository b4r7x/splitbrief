import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../../core/types/config-options.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from '../project/detection.js';
import { loadDetectionIntoStores } from './detection-adapter.js';
import { createDetectionService } from '../../engine/detection/service.js';
import type { DetectionDeps, DetectionService } from '../../engine/detection/service.js';

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

/**
 * Build deps where detectAll stamps the call generation (1, 2, 3, …) into the
 * planner's `version` field. Tests observe the generation that lands in
 * detectionStore instead of asserting on call counts.
 */
function makeCountingDeps(overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  let calls = 0;
  const detectAll = async () => {
    calls++;
    return {
      planners: [makePlanner({ version: `gen-${calls}` })],
      implementers: [makeImplementer()],
    };
  };
  return {
    detectAll,
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
    const deps: DetectionDeps = {
      detectAll: async () => ({ planners, implementers }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await loadDetectionIntoStores(deps, undefined, service);

    const state = detectionStore.get();
    expect(state.planners).toEqual(planners);
    expect(state.implementers).toEqual(implementers);
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
      const deps = makeCountingDeps();

      await loadDetectionIntoStores(deps, tempDir, service);
      // First call ran real detection — planner version stamped gen-1.
      expect(detectionStore.get().planners[0]?.version).toBe('gen-1');

      await service.getPendingSave();
      // Reset the store so we can observe what the second call writes.
      detectionStore.reset();

      await loadDetectionIntoStores(deps, tempDir, service);
      // Second call hit the cache — the cached payload (gen-1) is restored,
      // proving detectAll was NOT re-invoked (otherwise we would see gen-2).
      expect(detectionStore.get().planners[0]?.version).toBe('gen-1');
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

      const deps: DetectionDeps = {
        ...makeCountingDeps(),
        fetchModelsDevCatalog: vi.fn().mockResolvedValue(catalog),
        discoverAllCliTools: vi.fn().mockResolvedValue({ opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] }),
      };

      await loadDetectionIntoStores(deps, tempDir, service);
      await service.getPendingSave();

      detectionStore.reset();
      modelCacheStore.reset();

      await loadDetectionIntoStores(deps, tempDir, service);

      // Cached planner gen-1 is restored (not re-detected into gen-2).
      expect(detectionStore.get().planners[0]?.version).toBe('gen-1');
      expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
      expect(modelCacheStore.getProviderModels('opencode')).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);
    });

    it('always runs detection when projectDir is undefined (no cache scope)', async () => {
      const deps = makeCountingDeps();

      await loadDetectionIntoStores(deps, undefined, service);
      expect(detectionStore.get().planners[0]?.version).toBe('gen-1');

      await loadDetectionIntoStores(deps, undefined, service);
      // No projectDir → no cache path → every call re-detects.
      expect(detectionStore.get().planners[0]?.version).toBe('gen-2');
    });

    it('invalidate() forces re-detection on next load', async () => {
      const deps = makeCountingDeps();

      await loadDetectionIntoStores(deps, tempDir, service);
      expect(detectionStore.get().planners[0]?.version).toBe('gen-1');

      await service.getPendingSave();
      await service.invalidateDetection(tempDir);

      await loadDetectionIntoStores(deps, tempDir, service);
      // After invalidation the second load re-ran detection → gen-2 lands.
      expect(detectionStore.get().planners[0]?.version).toBe('gen-2');
    });
  });
});
