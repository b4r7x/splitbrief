import { createStore, storeBase } from './create-store.js';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { loadDetectionCache, saveDetectionCache, invalidateCache } from '../core/detection/index.js';

interface DetectionState {
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

const initial: DetectionState = {
  planners: [],
  implementers: [],
};

const store = createStore<DetectionState>(initial);

async function load(
  detectPlanners: () => Promise<PlannerDetection[]>,
  detectImplementers: () => Promise<ProviderDetection[]>,
  projectDir?: string,
): Promise<void> {
  if (projectDir) {
    const cached = await loadDetectionCache(projectDir);
    if (cached) {
      store.set(cached);
      return;
    }
  }

  const [planners, implementers] = await Promise.all([
    detectPlanners(),
    detectImplementers(),
  ]);
  store.set({ planners, implementers });

  if (projectDir) {
    saveDetectionCache(projectDir, planners, implementers).catch(() => {});
  }
}

async function invalidate(projectDir: string): Promise<void> {
  await invalidateCache(projectDir);
}

export const detectionStore = { ...storeBase(store), load, invalidate };
