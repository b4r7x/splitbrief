import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from './detection.js';
import type { DetectionDeps } from './detection.js';
import type { fetchModelsDevCatalog } from '../engine/providers/models-dev.js';

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

describe('detectionStore', () => {
  beforeEach(() => {
    detectionStore.reset();
    modelCacheStore.reset();
  });

  it('starts with empty planners and implementers', () => {
    const s = detectionStore.get();
    expect(s.planners).toEqual([]);
    expect(s.implementers).toEqual([]);
  });

  it('load() populates both planners and implementers from detectAll', async () => {
    const planners = [makePlanner({ tool: 'claude-code' }), makePlanner({ tool: 'codex', available: false })];
    const implementers = [makeImplementer({ provider: 'ollama' }), makeImplementer({ provider: 'lm-studio', available: false })];
    const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners, implementers }) });

    await detectionStore.load(deps);

    expect(deps.detectAll).toHaveBeenCalledOnce();
    const state = detectionStore.get();
    expect(state.planners).toBe(planners);
    expect(state.implementers).toBe(implementers);
  });

  it('reset() clears populated detection state', async () => {
    const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] }) });
    await detectionStore.load(deps);
    expect(detectionStore.get().planners).toHaveLength(1);

    detectionStore.reset();

    const s = detectionStore.get();
    expect(s.planners).toEqual([]);
    expect(s.implementers).toEqual([]);
  });

  describe('cache integration', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'tiny-spec-detection-store-test-'));
      detectionStore.reset();
    });

    afterEach(async () => {
      await detectionStore._pendingSave;
      await rm(tempDir, { recursive: true, force: true });
    });

    it('load() with projectDir uses cache on second call', async () => {
      const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] }) });

      await detectionStore.load(deps, tempDir);
      expect(deps.detectAll).toHaveBeenCalledOnce();
      expect(deps.fetchModelsDevCatalog).toHaveBeenCalledOnce();
      expect(deps.discoverAllCliTools).toHaveBeenCalledOnce();

      await detectionStore._pendingSave;

      await detectionStore.load(deps, tempDir);
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

      await detectionStore.load(deps, tempDir);
      await detectionStore._pendingSave;

      detectionStore.reset();
      modelCacheStore.reset();

      await detectionStore.load(deps, tempDir);

      expect(deps.detectAll).toHaveBeenCalledTimes(1);
      expect(deps.fetchModelsDevCatalog).toHaveBeenCalledTimes(2);
      expect(deps.discoverAllCliTools).toHaveBeenCalledTimes(2);
      expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
      expect(modelCacheStore.getProviderModels('opencode')).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);
    });

    it('load() without projectDir always runs detection', async () => {
      const deps = makeDeps();
      await detectionStore.load(deps);
      await detectionStore.load(deps);

      expect(deps.detectAll).toHaveBeenCalledTimes(2);
    });

    it('invalidate() forces re-detection on next load', async () => {
      const deps = makeDeps({ detectAll: vi.fn().mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] }) });

      await detectionStore.load(deps, tempDir);
      expect(deps.detectAll).toHaveBeenCalledOnce();

      await detectionStore.invalidate(tempDir);

      await detectionStore.load(deps, tempDir);
      expect(deps.detectAll).toHaveBeenCalledTimes(2);
    });
  });
});
