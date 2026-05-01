import { describe, it, expect } from 'vitest';
import { applyCLIOverrides, applyApproveOverride } from './overrides.js';
import type { Config } from '../../schemas/config.js';
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

describe('applyCLIOverrides — runner commands', () => {
  it('uses shell config for planner command override without explicit tool', () => {
    const result = applyCLIOverrides(baseConfig, {
      planner: { command: 'custom-planner' },
    });

    expect(result.planner.kind).toBe('shell');
    if (result.planner.kind === 'shell') {
      expect(result.planner.command).toBe('custom-planner');
    }
  });

  it('uses shell config for implementer command override without explicit tool', () => {
    const result = applyCLIOverrides(baseConfig, {
      implementer: { command: 'custom-implementer' },
    });

    expect(result.implementer.kind).toBe('shell');
    if (result.implementer.kind === 'shell') {
      expect(result.implementer.command).toBe('custom-implementer');
      expect(result.implementer.model).toBe(baseConfig.implementer.model);
    }
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
