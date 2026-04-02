import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlannerBackend } from './types.js';

vi.mock('./base.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./base.js')>();
  return {
    ...orig,
    createPlannerBase: vi.fn().mockImplementation((config) => {
      return {
        name: config.name,
        conversational: config.conversational ?? false,
        plan: vi.fn(),
        regenerate: vi.fn(),
        escalateHint: vi.fn(),
        escalateFull: vi.fn(),
        isAvailable: config.isAvailable,
        getVersion: config.getVersion,
        getPricing: vi.fn(),
        _config: config,
      };
    }),
  };
});

vi.mock('../output-parsers.js', () => ({
  accumulateUsage: vi.fn().mockImplementation((current, delta) => {
    if (current) return { inputTokens: current.inputTokens + delta.inputTokens, outputTokens: current.outputTokens + delta.outputTokens };
    return { ...delta };
  }),
}));

import { createAgentSdkPlanner } from './agent-sdk.js';
import { createPlannerBase } from './base.js';

describe('agent-sdk planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a planner with correct interface', () => {
    const planner = createAgentSdkPlanner();
    expect(planner).toHaveProperty('plan');
    expect(planner).toHaveProperty('escalateHint');
    expect(planner).toHaveProperty('escalateFull');
    expect(planner).toHaveProperty('getVersion');
    expect(planner).toHaveProperty('isAvailable');
  });

  it('has name agent-sdk', () => {
    const planner = createAgentSdkPlanner();
    expect(planner.name).toBe('agent-sdk');
  });

  it('is conversational', () => {
    const planner = createAgentSdkPlanner();
    expect(planner.conversational).toBe(true);
  });

  it('passes correct config to createPlannerBase', () => {
    createAgentSdkPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    expect(baseConfig.name).toBe('agent-sdk');
    expect(baseConfig.pricingKey).toBe('agent-sdk');
    expect(baseConfig.conversational).toBe(true);
  });

  it('getVersion returns null', async () => {
    const planner = createAgentSdkPlanner();
    const version = await planner.getVersion();
    expect(version).toBeNull();
  });

  it('isAvailable returns false without ANTHROPIC_API_KEY', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const planner = createAgentSdkPlanner();
      const available = await planner.isAvailable();
      expect(available).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('escalateHintSuccess checks text length', () => {
    createAgentSdkPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    expect(baseConfig.escalateHintSuccess!({ text: 'hint', usage: null })).toBe(true);
    expect(baseConfig.escalateHintSuccess!({ text: '', usage: null })).toBe(false);
  });
});
