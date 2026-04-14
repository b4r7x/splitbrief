import { describe, it, expect, beforeEach } from 'vitest';
import { modelCacheStore } from '../../../stores/model-cache.js';
import { buildRightModelsForPicker } from './catalog-adapter.js';

describe('buildRightModelsForPicker', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('returns only custom models when currentItem is undefined', () => {
    const result = buildRightModelsForPicker({
      isPlanner: false,
      customModels: ['my-model'],
      currentItem: undefined,
    });
    expect(result).toEqual([{ id: 'my-model', isCustom: true }]);
  });

  it('exposes bundled agent-sdk models from store', () => {
    const result = buildRightModelsForPicker({
      isPlanner: false,
      customModels: [],
      currentItem: {
        id: 'agent-sdk',
        displayName: 'Agent SDK',
        kind: 'agent-sdk',
        available: true,
        badge: 'SDK',
      },
    });
    expect(result.map(m => m.id)).toContain('claude-sonnet-4-6');
  });

  it('returns empty model list for shell kind', () => {
    const result = buildRightModelsForPicker({
      isPlanner: false,
      customModels: [],
      currentItem: {
        id: 'shell',
        displayName: 'Shell',
        kind: 'shell',
        available: true,
        badge: 'Custom',
      },
    });
    expect(result).toEqual([]);
  });

  it('prepends custom models before known models', () => {
    const result = buildRightModelsForPicker({
      isPlanner: false,
      customModels: ['my-custom'],
      currentItem: {
        id: 'agent-sdk',
        displayName: 'Agent SDK',
        kind: 'agent-sdk',
        available: true,
        badge: 'SDK',
      },
    });
    expect(result[0]).toEqual({ id: 'my-custom', isCustom: true });
    expect(result.length).toBeGreaterThan(1);
  });
});
