import { describe, expect, it } from 'vitest';
import type { PlannerDetection, ProviderDetection } from '../../core/types/config-options.js';
import {
  buildImplementerPickerOptions,
  buildPlannerPickerOptions,
} from './picker-options.js';
import { buildRightModels } from './picker-model-catalog.js';

function makePlannerDetection(
  tool: PlannerDetection['tool'],
  extra: Partial<PlannerDetection> = {},
): PlannerDetection {
  return {
    tool,
    type: tool === 'shell' ? 'shell' : 'cli',
    available: false,
    ...extra,
  };
}

function makeImplementerDetection(
  provider: ProviderDetection['provider'],
  extra: Partial<ProviderDetection> = {},
): ProviderDetection {
  return {
    provider,
    available: false,
    isLocal: false,
    ...extra,
  };
}

describe('picker options', () => {
  it('builds identical planner and implementer catalogs for the same detections', () => {
    const plannerDetections: PlannerDetection[] = [
      makePlannerDetection('claude-code', { available: true, version: '1.2.3' }),
      makePlannerDetection('copilot'),
      makePlannerDetection('shell', { available: true }),
    ];
    const implementerDetections: ProviderDetection[] = [
      makeImplementerDetection('anthropic', { available: true }),
      makeImplementerDetection('ollama', { available: true, isLocal: true }),
      makeImplementerDetection('openrouter'),
    ];
    const hasApiKeyOverride = (provider: string) => provider === 'agent-sdk' || provider === 'openai';

    const plannerItems = buildPlannerPickerOptions({
      detections: plannerDetections,
      implementerDetections,
      hasApiKeyOverride,
    });
    const implementerItems = buildImplementerPickerOptions({
      detections: implementerDetections,
      plannerDetections,
      hasApiKeyOverride,
    });

    expect(plannerItems).toEqual(implementerItems);
  });

  it('exposes bundled Agent SDK models for implementers', () => {
    const models = buildRightModels({
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

    expect(models.map(model => model.id)).toContain('claude-sonnet-4-6');
  });

  it('includes the custom agent runner in both picker catalogs', () => {
    const plannerItems = buildPlannerPickerOptions({ detections: [] });
    const implementerItems = buildImplementerPickerOptions({ detections: [] });

    expect(plannerItems.some((item) => item.id === 'agent' && item.kind === 'agent')).toBe(true);
    expect(implementerItems.some((item) => item.id === 'agent' && item.kind === 'agent')).toBe(true);
  });
});
