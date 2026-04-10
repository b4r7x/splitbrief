import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { detectionStore } from './detection.js';

const detectPlannersMock = vi.fn<() => Promise<PlannerDetection[]>>();
const detectImplementersMock = vi.fn<() => Promise<ProviderDetection[]>>();

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

describe('detectionStore', () => {
  beforeEach(() => {
    detectPlannersMock.mockReset();
    detectImplementersMock.mockReset();
    detectionStore.reset();
  });

  it('starts with empty planners and implementers', () => {
    const s = detectionStore.get();
    expect(s.planners).toEqual([]);
    expect(s.implementers).toEqual([]);
  });

  it('load() populates both planners and implementers from parallel detection', async () => {
    const planners = [makePlanner({ tool: 'claude-code' }), makePlanner({ tool: 'codex', available: false })];
    const implementers = [makeImplementer({ provider: 'ollama' }), makeImplementer({ provider: 'lm-studio', available: false })];
    detectPlannersMock.mockResolvedValue(planners);
    detectImplementersMock.mockResolvedValue(implementers);

    await detectionStore.load(detectPlannersMock, detectImplementersMock);

    expect(detectPlannersMock).toHaveBeenCalledOnce();
    expect(detectImplementersMock).toHaveBeenCalledOnce();
    const state = detectionStore.get();
    expect(state.planners).toBe(planners);
    expect(state.implementers).toBe(implementers);
  });

  it('load() resolves when both detectors are called in parallel', async () => {
    let plannerResolved = false;
    let implementerResolved = false;
    detectPlannersMock.mockImplementation(async () => {
      plannerResolved = true;
      return [];
    });
    detectImplementersMock.mockImplementation(async () => {
      implementerResolved = true;
      return [];
    });

    await detectionStore.load(detectPlannersMock, detectImplementersMock);

    expect(plannerResolved).toBe(true);
    expect(implementerResolved).toBe(true);
  });

  it('reset() clears populated detection state', async () => {
    detectPlannersMock.mockResolvedValue([makePlanner()]);
    detectImplementersMock.mockResolvedValue([makeImplementer()]);
    await detectionStore.load(detectPlannersMock, detectImplementersMock);
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
      detectPlannersMock.mockReset();
      detectImplementersMock.mockReset();
      detectionStore.reset();
      detectPlannersMock.mockResolvedValue([makePlanner()]);
      detectImplementersMock.mockResolvedValue([makeImplementer()]);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('load() with projectDir uses cache on second call', async () => {
      await detectionStore.load(detectPlannersMock, detectImplementersMock, tempDir);
      expect(detectPlannersMock).toHaveBeenCalledOnce();
      expect(detectImplementersMock).toHaveBeenCalledOnce();

      // Let the fire-and-forget saveDetectionCache complete
      await new Promise((r) => setTimeout(r, 50));

      await detectionStore.load(detectPlannersMock, detectImplementersMock, tempDir);
      expect(detectPlannersMock).toHaveBeenCalledTimes(1);
      expect(detectImplementersMock).toHaveBeenCalledTimes(1);

      const state = detectionStore.get();
      expect(state.planners).toHaveLength(1);
      expect(state.implementers).toHaveLength(1);
    });

    it('load() without projectDir always runs detection', async () => {
      await detectionStore.load(detectPlannersMock, detectImplementersMock);
      await detectionStore.load(detectPlannersMock, detectImplementersMock);

      expect(detectPlannersMock).toHaveBeenCalledTimes(2);
      expect(detectImplementersMock).toHaveBeenCalledTimes(2);
    });

    it('invalidate() forces re-detection on next load', async () => {
      await detectionStore.load(detectPlannersMock, detectImplementersMock, tempDir);
      expect(detectPlannersMock).toHaveBeenCalledOnce();

      await detectionStore.invalidate(tempDir);

      await detectionStore.load(detectPlannersMock, detectImplementersMock, tempDir);
      expect(detectPlannersMock).toHaveBeenCalledTimes(2);
      expect(detectImplementersMock).toHaveBeenCalledTimes(2);
    });
  });
});
