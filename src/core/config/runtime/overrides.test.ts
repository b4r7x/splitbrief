import { describe, it, expect } from 'vitest';
import { applyCLIOverrides, applyApproveOverride } from './overrides.js';
import type { Config } from '../../schemas/config.js';

const baseConfig: Config = {
  version: 3,
  planner: { kind: 'cli', tool: 'claude-code' },
  implementer: {
    kind: 'api',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    apiBase: 'http://localhost:11434/v1',
    contextLength: 32768,
    temperature: 0.3,
  },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: {
    approve: 'default',
    maxRetries: 3,
    persistTranscript: true,
    mode: 'standard',
  },
};

describe('applyCLIOverrides — approve / auto', () => {
  it('--approve <level> sets workflow.approve', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'none' });
    expect(result.workflow.approve).toBe('none');
  });

  it('--approve none also dual-writes legacy autoApprove* keys', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'none' });
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });

  it('--approve all does not dual-write legacy keys', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'all' });
    expect(result.workflow.approve).toBe('all');
    expect(result.workflow.autoApproveSpec).toBeUndefined();
    expect(result.workflow.autoApprovePlan).toBeUndefined();
  });

  it('--auto sets approve=none and dual-writes autoApprove*', () => {
    const result = applyCLIOverrides(baseConfig, { autoApprove: true });
    expect(result.workflow.approve).toBe('none');
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });

  it('--auto false does not change approve', () => {
    const result = applyCLIOverrides(baseConfig, { autoApprove: false });
    expect(result.workflow.approve).toBe('default');
    expect(result.workflow.autoApproveSpec).toBe(false);
    expect(result.workflow.autoApprovePlan).toBe(false);
  });

  it('--auto wins when both --auto and --approve are provided', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'spec', autoApprove: true });
    expect(result.workflow.approve).toBe('none');
  });

  it('throws on invalid --approve value', () => {
    expect(() => applyCLIOverrides(baseConfig, { approve: 'bogus' })).toThrow(/Must be one of/);
  });

  it('accepts --approve default', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'default' });
    expect(result.workflow.approve).toBe('default');
  });
});

describe('applyApproveOverride', () => {
  it('sets approve and dual-writes when level is none', () => {
    const result = applyApproveOverride(baseConfig, 'none');
    expect(result.workflow.approve).toBe('none');
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });

  it('only sets approve for non-none levels', () => {
    const result = applyApproveOverride(baseConfig, 'plan');
    expect(result.workflow.approve).toBe('plan');
    expect(result.workflow.autoApproveSpec).toBeUndefined();
  });
});

describe('applyCLIOverrides — plannerEffort', () => {
  it('sets planner.effort when valid', () => {
    const result = applyCLIOverrides(baseConfig, { plannerEffort: 'high' });
    expect(result.planner.effort).toBe('high');
  });
  it('throws on invalid effort value', () => {
    expect(() => applyCLIOverrides(baseConfig, { plannerEffort: 'bogus' })).toThrow(/Must be one of/);
  });
  it('leaves config untouched when override absent', () => {
    const result = applyCLIOverrides(baseConfig, {});
    expect(result.planner.effort).toBeUndefined();
  });
});

describe('applyCLIOverrides — yolo', () => {
  it('yolo override disables approval', () => {
    const result = applyCLIOverrides(baseConfig, { yolo: true });
    expect(result.approval?.enabled).toBe(false);
  });

  it('yolo override preserves other approval fields', () => {
    const config: Config = {
      ...baseConfig,
      approval: {
        enabled: true,
        tiers: { destructive: 'confirm' },
        feedRejectionsToPlanner: true,
      },
    };
    const result = applyCLIOverrides(config, { yolo: true });
    expect(result.approval?.enabled).toBe(false);
    expect(result.approval?.tiers?.destructive).toBe('confirm');
    expect(result.approval?.feedRejectionsToPlanner).toBe(true);
  });

  it('non-yolo override does not change approval', () => {
    const config: Config = { ...baseConfig, approval: { enabled: true, feedRejectionsToPlanner: true } };
    const result = applyCLIOverrides(config, {});
    expect(result.approval?.enabled).toBe(true);
  });
});
