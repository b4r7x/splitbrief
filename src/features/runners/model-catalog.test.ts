import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { PlannerDetection, ProviderDetection } from '../../core/discovery/detection.js';
import {
  buildImplementerPickerOptions,
  buildPlannerPickerOptions,
  buildRightModels,
  isCurrentConfig,
  modelsForImplementerProvider,
  modelsForPlannerTool,
  sortModelsByRecency,
} from './model-catalog.js';

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
    const hasApiKeyOverride = (provider: string) =>
      provider === 'agent-sdk' || provider === 'openai';

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

    expect(models.map((model) => model.id)).toContain('claude-sonnet-4-6');
  });

  it('keeps buildRightModels deterministic unless a cache is passed', () => {
    const currentItem = {
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'api' as const,
      available: true,
      badge: 'API',
    };
    const cache = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'runtime-only-model' }],
    };

    expect(
      buildRightModels({ isPlanner: false, customModels: [], currentItem }).map(
        (model) => model.id,
      ),
    ).not.toContain('runtime-only-model');
    expect(
      buildRightModels({ isPlanner: false, customModels: [], currentItem, cache }).map(
        (model) => model.id,
      ),
    ).toContain('runtime-only-model');
  });

  it('keeps model helper exports available', () => {
    expect(
      sortModelsByRecency([{ id: 'gpt-5' }, { id: 'gpt-4' }]).map((model) => model.id),
    ).toEqual(['gpt-5', 'gpt-4']);
    expect(modelsForPlannerTool('claude-code').length).toBeGreaterThan(0);
    expect(modelsForImplementerProvider('shell', 'shell')).toEqual([]);
  });

  it('includes the custom agent runner in both picker catalogs', () => {
    const plannerItems = buildPlannerPickerOptions({ detections: [] });
    const implementerItems = buildImplementerPickerOptions({ detections: [] });

    expect(plannerItems.some((item) => item.id === 'agent' && item.kind === 'agent')).toBe(true);
    expect(implementerItems.some((item) => item.id === 'agent' && item.kind === 'agent')).toBe(
      true,
    );
  });

  it('marks the resolved default implementer profile as current', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'deepseek',
        apiBase: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      },
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
          },
        },
      },
    });

    expect(
      isCurrentConfig(
        { id: 'ollama', displayName: 'Ollama', kind: 'api', available: true, badge: 'API' },
        config,
        'implementer',
      ),
    ).toBe(true);
    expect(
      isCurrentConfig(
        { id: 'deepseek', displayName: 'DeepSeek', kind: 'api', available: true, badge: 'API' },
        config,
        'implementer',
      ),
    ).toBe(false);
  });
});
