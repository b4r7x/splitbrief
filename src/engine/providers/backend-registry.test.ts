import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlannerDetection } from '../detection.js';
import type { ProviderDetection } from './types.js';
import {
  getDisplayName,
  buildPlannerOptions,
  buildImplementerOptions,
  modelsForPlannerBackend,
  modelsForImplementerBackend,
  DISPLAY_NAMES,
} from './backend-registry.js';

describe('getDisplayName', () => {
  it('returns pretty name for known ids', () => {
    expect(getDisplayName('claude-code')).toBe('Claude Code');
    expect(getDisplayName('lm-studio')).toBe('LM Studio');
    expect(getDisplayName('openrouter')).toBe('OpenRouter');
  });

  it('returns id as-is for unknown ids', () => {
    expect(getDisplayName('my-custom-thing')).toBe('my-custom-thing');
  });
});

describe('buildPlannerOptions', () => {
  const detections: PlannerDetection[] = [
    { tool: 'claude-code', type: 'cli', available: true, version: '1.2.3' },
    { tool: 'codex', type: 'cli', available: false },
    { tool: 'anthropic', type: 'api', available: true },
    { tool: 'ollama', type: 'provider', available: true },
    { tool: 'shell', type: 'shell', available: true },
  ];

  it('maps detections to BackendOptions with display names', () => {
    const options = buildPlannerOptions(detections);
    expect(options.find(o => o.id === 'claude-code')?.displayName).toBe('Claude Code');
    expect(options.find(o => o.id === 'codex')?.displayName).toBe('Codex');
    expect(options.find(o => o.id === 'anthropic')?.displayName).toBe('Anthropic');
  });

  it('preserves availability from detections', () => {
    const options = buildPlannerOptions(detections);
    expect(options.find(o => o.id === 'claude-code')?.available).toBe(true);
    expect(options.find(o => o.id === 'codex')?.available).toBe(false);
  });

  it('preserves version from detections', () => {
    const options = buildPlannerOptions(detections);
    expect(options.find(o => o.id === 'claude-code')?.version).toBe('1.2.3');
    expect(options.find(o => o.id === 'codex')?.version).toBeUndefined();
  });

  it('puts shell at start when all available', () => {
    const allAvailable: PlannerDetection[] = [
      { tool: 'claude-code', type: 'cli', available: true },
      { tool: 'shell', type: 'shell', available: true },
    ];
    const options = buildPlannerOptions(allAvailable);
    expect(options[0].id).toBe('shell');
    expect(options[0].kind).toBe('shell');
  });

  it('sorts available items before unavailable', () => {
    const options = buildPlannerOptions(detections);
    const availableItems = options.filter(o => o.available);
    const unavailableItems = options.filter(o => !o.available);

    // All available items should come before unavailable
    const lastAvailableIndex = options.findIndex(o => o.id === availableItems[availableItems.length - 1].id);
    const firstUnavailableIndex = options.findIndex(o => o.id === unavailableItems[0].id);
    expect(lastAvailableIndex).toBeLessThan(firstUnavailableIndex);
  });

  it('assigns correct badges', () => {
    const options = buildPlannerOptions(detections);
    expect(options.find(o => o.id === 'claude-code')?.badge).toBe('CLI');
    expect(options.find(o => o.id === 'anthropic')?.badge).toBe('API');
    expect(options.find(o => o.id === 'ollama')?.badge).toBe('Provider');
    expect(options.find(o => o.id === 'shell')?.badge).toBe('Custom');
  });

  it('returns empty array for empty detections', () => {
    expect(buildPlannerOptions([])).toEqual([]);
  });
});

describe('buildImplementerOptions', () => {
  const detections: ProviderDetection[] = [
    { provider: 'ollama', available: true, models: ['qwen2.5-coder:7b', 'llama3.3:latest'], isLocal: true },
    { provider: 'lm-studio', available: false, isLocal: true },
    { provider: 'deepseek', available: false, isLocal: false },
  ];

  it('includes shell as first available item', () => {
    const options = buildImplementerOptions(detections);
    const availableItems = options.filter(o => o.available);
    expect(availableItems[0].id).toBe('shell');
    expect(availableItems[0].kind).toBe('shell');
  });

  it('includes tool implementers', () => {
    const options = buildImplementerOptions(detections);
    const toolOptions = options.filter(o => o.kind === 'cli');
    expect(toolOptions.length).toBeGreaterThan(0);
    expect(toolOptions.map(o => o.id)).toContain('claude-code');
    expect(toolOptions.map(o => o.id)).toContain('codex');
  });

  it('includes detected providers', () => {
    const options = buildImplementerOptions(detections);
    const ollama = options.find(o => o.id === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama?.available).toBe(true);
    expect(ollama?.badge).toBe('local, free');
  });

  it('marks unavailable providers', () => {
    const options = buildImplementerOptions(detections);
    expect(options.find(o => o.id === 'lm-studio')?.available).toBe(false);
  });

  it('sorts available items before unavailable', () => {
    const options = buildImplementerOptions(detections);
    const availableItems = options.filter(o => o.available);
    const unavailableItems = options.filter(o => !o.available);

    if (unavailableItems.length > 0) {
      const lastAvailableIndex = options.findIndex(o => o.id === availableItems[availableItems.length - 1].id);
      const firstUnavailableIndex = options.findIndex(o => o.id === unavailableItems[0].id);
      expect(lastAvailableIndex).toBeLessThan(firstUnavailableIndex);
    }
  });

  it('adds known providers not in detections', () => {
    const options = buildImplementerOptions([]);
    const providerOptions = options.filter(o => o.kind === 'provider');
    expect(providerOptions.length).toBeGreaterThan(0);
  });

  it('uses display names for all items', () => {
    const options = buildImplementerOptions(detections);
    expect(options.find(o => o.id === 'claude-code')?.displayName).toBe('Claude Code');
    expect(options.find(o => o.id === 'ollama')?.displayName).toBe('Ollama');
    expect(options.find(o => o.id === 'lm-studio')?.displayName).toBe('LM Studio');
  });
});

describe('modelsForPlannerBackend', () => {
  it('returns known models for a planner tool', () => {
    const models = modelsForPlannerBackend('claude-code');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.isDefault)).toBe(true);
  });

  it('returns empty array for unknown backend', () => {
    expect(modelsForPlannerBackend('nonexistent')).toEqual([]);
  });
});

describe('modelsForImplementerBackend', () => {
  const detections: ProviderDetection[] = [
    { provider: 'ollama', available: true, models: ['qwen2.5-coder:7b', 'custom-model:latest'], isLocal: true },
    { provider: 'deepseek', available: true, isLocal: false },
  ];

  it('returns detected models merged with known for providers', () => {
    const models = modelsForImplementerBackend(detections, 'ollama', 'provider');
    expect(models.some(m => m.id === 'qwen2.5-coder:7b' && m.isDetected)).toBe(true);
    expect(models.some(m => m.id === 'custom-model:latest' && m.isDetected)).toBe(true);
  });

  it('returns known models when no detected models', () => {
    const models = modelsForImplementerBackend(detections, 'deepseek', 'provider');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].isDetected).toBeFalsy();
  });

  it('returns planner known models for tool-type backends', () => {
    const models = modelsForImplementerBackend(detections, 'claude-code', 'cli');
    expect(models.length).toBeGreaterThan(0);
  });

  it('returns empty array for shell', () => {
    expect(modelsForImplementerBackend(detections, 'shell', 'shell')).toEqual([]);
  });

  it('deduplicates when detected and known overlap', () => {
    const models = modelsForImplementerBackend(detections, 'ollama', 'provider');
    const ids = models.map(m => m.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
