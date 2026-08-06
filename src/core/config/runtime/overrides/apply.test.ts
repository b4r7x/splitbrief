import { describe, it, expect } from 'vitest';
import { applyCLIOverrides, applyApproveOverride } from './apply.js';
import type { Config } from '../../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig: Config = makeConfig({ workflow: { approve: 'default' } });

describe('applyCLIOverrides — approve', () => {
  it('--approve <level> sets workflow.approve', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'none' });
    expect(result.workflow.approve).toBe('none');
  });

  it('--approve none writes no companion keys beyond approve', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'none' });
    expect(result.workflow).not.toHaveProperty('autoApproveSpec');
    expect(result.workflow).not.toHaveProperty('autoApprovePlan');
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
  it.each(['none', 'plan'] as const)('sets approve to %s and nothing else', (level) => {
    const result = applyApproveOverride(baseConfig, level);
    expect(result.workflow).toEqual({ ...baseConfig.workflow, approve: level });
  });
});

describe('applyCLIOverrides — plannerEffort', () => {
  it('sets planner.effort when valid', () => {
    const result = applyCLIOverrides(baseConfig, { plannerEffort: 'high' });
    expect(result.planner.effort).toBe('high');
  });
  it('throws on invalid effort value', () => {
    expect(() => applyCLIOverrides(baseConfig, { plannerEffort: 'bogus' })).toThrow(
      /Must be one of/,
    );
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
    const config: Config = {
      ...baseConfig,
      approval: { enabled: true, feedRejectionsToPlanner: true },
    };
    const result = applyCLIOverrides(config, {});
    expect(result.approval?.enabled).toBe(true);
  });
});

describe('applyCLIOverrides — contextLength, mode, budget', () => {
  it('applies contextLength override', () => {
    const result = applyCLIOverrides(baseConfig, { contextLength: 16384 });
    expect(result.implementer.contextLength).toBe(16384);
  });

  it.each(['full', 'spec-kit'])('rejects the removed %s mode alias', (mode) => {
    expect(() => applyCLIOverrides(baseConfig, { mode: mode as 'speckit' })).toThrow(
      /Invalid mode: (full|spec-kit)\. Must be one of: instant, quick, standard, speckit/,
    );
  });

  it('throws on NaN budget override', () => {
    expect(() => applyCLIOverrides(baseConfig, { budget: NaN })).toThrow('Invalid budget');
  });

  it('throws on zero budget override', () => {
    expect(() => applyCLIOverrides(baseConfig, { budget: 0 })).toThrow('Invalid budget');
  });

  it('throws on negative budget override', () => {
    expect(() => applyCLIOverrides(baseConfig, { budget: -5 })).toThrow('Invalid budget');
  });

  it('applies valid budget override', () => {
    const result = applyCLIOverrides(baseConfig, { budget: 10.5 });
    expect(result.workflow.maxBudget).toBe(10.5);
  });

  it('preserves a configured approve level when no approve override is given', () => {
    const config: Config = { ...baseConfig, workflow: { ...baseConfig.workflow, approve: 'none' } };
    expect(applyCLIOverrides(config, {}).workflow.approve).toBe('none');
  });
});
