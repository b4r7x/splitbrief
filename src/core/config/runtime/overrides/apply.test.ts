import { describe, it, expect } from 'vitest';
import { applyCLIOverrides } from './apply.js';
import { workflowOptsToCLIOverrides } from './from-options.js';
import type { Config } from '../../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig: Config = makeConfig({ workflow: { approve: 'plan' } });

describe('applyCLIOverrides — plannerEffort', () => {
  it('sets planner.effort when valid', () => {
    const result = applyCLIOverrides(baseConfig, { plannerEffort: 'high' });
    expect(result.planner.effort).toBe('high');
  });
  it('accepts max, the top of the vocabulary', () => {
    const result = applyCLIOverrides(baseConfig, { plannerEffort: 'max' });
    expect(result.planner.effort).toBe('max');
  });
  it('refuses a level outside the vocabulary and names every level it takes', () => {
    expect(() => applyCLIOverrides(baseConfig, { plannerEffort: 'ultra' })).toThrow(
      'Must be one of: none, minimal, low, medium, high, xhigh, max',
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
        feedRejectionsToPlanner: true,
        allowedPaths: ['docs/**'],
      },
    };
    const result = applyCLIOverrides(config, { yolo: true });
    expect(result.approval?.enabled).toBe(false);
    expect(result.approval?.allowedPaths).toEqual(['docs/**']);
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

describe('applyCLIOverrides — contextLength', () => {
  it('applies contextLength override', () => {
    const result = applyCLIOverrides(baseConfig, { contextLength: 16384 });
    expect(result.implementer.contextLength).toBe(16384);
  });

  it('preserves a configured approve level when no approve override is given', () => {
    const config: Config = { ...baseConfig, workflow: { ...baseConfig.workflow, approve: 'none' } };
    expect(applyCLIOverrides(config, {}).workflow.approve).toBe('none');
  });
});

describe('applyCLIOverrides — the reviewer seat', () => {
  it('--reviewer codex --reviewer-model <id> writes reviewer and leaves planner untouched', () => {
    const result = applyCLIOverrides(
      baseConfig,
      workflowOptsToCLIOverrides({ reviewer: 'codex', reviewerModel: 'gpt-5.4' }),
    );

    expect(result.reviewer).toMatchObject({ kind: 'cli', tool: 'codex', model: 'gpt-5.4' });
    expect(result.planner).toEqual(baseConfig.planner);
  });

  it('leaves reviewer unset when no reviewer flag is given', () => {
    expect(applyCLIOverrides(baseConfig, workflowOptsToCLIOverrides({})).reviewer).toBeUndefined();
  });

  it('--reviewer-effort applies to the reviewer seat, not the planner', () => {
    const result = applyCLIOverrides(
      baseConfig,
      workflowOptsToCLIOverrides({ reviewer: 'codex', reviewerEffort: 'high' }),
    );

    expect(result.reviewer?.effort).toBe('high');
    expect(result.planner.effort).toBeUndefined();
  });

  it('refuses --reviewer-effort alone rather than forking the inherited seat', () => {
    expect(() =>
      applyCLIOverrides(baseConfig, workflowOptsToCLIOverrides({ reviewerEffort: 'high' })),
    ).toThrow(/inherits the planner; pass --reviewer/);
  });
});
