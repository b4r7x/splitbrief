import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { PlannerDetection, ProviderDetection } from '../../core/discovery/detection.js';
import {
  buildImplementerPickerOptions,
  buildPlannerPickerOptions,
  buildRightModels,
  isCurrentConfig,
  modelsForImplementerProvider,
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

  it('sorts models by default flag, release date, embedded dates, and name', () => {
    const input = [
      { id: 'new-model-20250101', releaseDate: '2025-01-01' },
      { id: 'release-old', releaseDate: '2024-01-01' },
      { id: 'release-new', releaseDate: '2025-01-01' },
      { id: 'old-default', isDefault: true },
      { id: 'model-20240101' },
      { id: 'model-20250101' },
      { id: 'gpt-4' },
      { id: 'gpt-5' },
      { id: 'gemini-2.0-pro' },
      { id: 'gemini-2.5-pro' },
    ];

    expect(sortModelsByRecency(input).map((model) => model.id)).toEqual([
      'old-default',
      'new-model-20250101',
      'release-new',
      'release-old',
      'model-20250101',
      'model-20240101',
      'gpt-5',
      'gpt-4',
      'gemini-2.5-pro',
      'gemini-2.0-pro',
    ]);
    expect(input.map((model) => model.id)).toEqual([
      'new-model-20250101',
      'release-old',
      'release-new',
      'old-default',
      'model-20240101',
      'model-20250101',
      'gpt-4',
      'gpt-5',
      'gemini-2.0-pro',
      'gemini-2.5-pro',
    ]);
  });

  it('buildRightModels returns models for claude-code and empty catalogs for shell/agent', () => {
    expect(
      buildRightModels({
        isPlanner: true,
        customModels: [],
        currentItem: {
          id: 'claude-code',
          displayName: 'Claude Code',
          kind: 'cli',
          available: true,
          badge: 'CLI',
        },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      buildRightModels({
        isPlanner: false,
        customModels: [],
        currentItem: {
          id: 'shell',
          displayName: 'Shell',
          kind: 'shell',
          available: true,
          badge: 'Shell',
        },
      }),
    ).toEqual([]);
    expect(
      buildRightModels({
        isPlanner: false,
        customModels: [],
        currentItem: {
          id: 'agent',
          displayName: 'Agent',
          kind: 'agent',
          available: true,
          badge: 'Agent',
        },
      }),
    ).toEqual([]);
    expect(modelsForImplementerProvider('shell', 'shell')).toEqual([]);
    expect(modelsForImplementerProvider('agent', 'agent')).toEqual([]);
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
