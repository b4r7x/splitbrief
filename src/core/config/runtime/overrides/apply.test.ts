import { describe, it, expect, vi } from 'vitest';
import { applyCLIOverrides, applyApproveOverride } from './apply.js';
import type { Config } from '../../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

function buildBaseConfig(): Config {
  const c = makeConfig({ workflow: { approve: 'default' } });
  delete (c.workflow as Record<string, unknown>).autoApproveSpec;
  delete (c.workflow as Record<string, unknown>).autoApprovePlan;
  return c;
}
const baseConfig: Config = buildBaseConfig();

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

  it('--auto overrides an explicit --approve and warns instead of silently winning', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = applyCLIOverrides(baseConfig, { approve: 'spec', autoApprove: true });
      expect(result.workflow.approve).toBe('none');
      const output = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toMatch(/--approve/);
      expect(output).toMatch(/overrid|ignored/i);
    } finally {
      stderr.mockRestore();
    }
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

  it('applies legacy full mode override as speckit', () => {
    const result = applyCLIOverrides(baseConfig, { mode: 'full' as 'speckit' });
    expect(result.workflow.mode).toBe('speckit');
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

  it('preserves autoApproveSpec and autoApprovePlan when autoApprove is omitted', () => {
    const config: Config = {
      ...baseConfig,
      workflow: {
        ...baseConfig.workflow,
        autoApproveSpec: true,
        autoApprovePlan: true,
      },
    };
    const result = applyCLIOverrides(config, { autoApprove: undefined });
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });
});
