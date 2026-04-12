import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { detectionStore } from './detection.js';

vi.mock('../engine/detection/index.js', () => ({
  detectAll: vi.fn(),
}));

import { detectAll } from '../engine/detection/index.js';

const detectAllMock = vi.mocked(detectAll);

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
    detectAllMock.mockReset();
    detectionStore.reset();
  });

  it('starts with empty planners and implementers', () => {
    const s = detectionStore.get();
    expect(s.planners).toEqual([]);
    expect(s.implementers).toEqual([]);
  });

  it('load() populates both planners and implementers from detectAll', async () => {
    const planners = [makePlanner({ tool: 'claude-code' }), makePlanner({ tool: 'codex', available: false })];
    const implementers = [makeImplementer({ provider: 'ollama' }), makeImplementer({ provider: 'lm-studio', available: false })];
    detectAllMock.mockResolvedValue({ planners, implementers });

    await detectionStore.load();

    expect(detectAllMock).toHaveBeenCalledOnce();
    const state = detectionStore.get();
    expect(state.planners).toBe(planners);
    expect(state.implementers).toBe(implementers);
  });

  it('reset() clears populated detection state', async () => {
    detectAllMock.mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] });
    await detectionStore.load();
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
      detectAllMock.mockReset();
      detectionStore.reset();
      detectAllMock.mockResolvedValue({ planners: [makePlanner()], implementers: [makeImplementer()] });
    });

    afterEach(async () => {
      await detectionStore._pendingSave;
      await rm(tempDir, { recursive: true, force: true });
    });

    it('load() with projectDir uses cache on second call', async () => {
      await detectionStore.load(tempDir);
      expect(detectAllMock).toHaveBeenCalledOnce();

      await detectionStore._pendingSave;

      await detectionStore.load(tempDir);
      expect(detectAllMock).toHaveBeenCalledTimes(1);

      const state = detectionStore.get();
      expect(state.planners).toHaveLength(1);
      expect(state.implementers).toHaveLength(1);
    });

    it('load() without projectDir always runs detection', async () => {
      await detectionStore.load();
      await detectionStore.load();

      expect(detectAllMock).toHaveBeenCalledTimes(2);
    });

    it('invalidate() forces re-detection on next load', async () => {
      await detectionStore.load(tempDir);
      expect(detectAllMock).toHaveBeenCalledOnce();

      await detectionStore.invalidate(tempDir);

      await detectionStore.load(tempDir);
      expect(detectAllMock).toHaveBeenCalledTimes(2);
    });
  });
});
