import { afterEach, describe, it, expect, vi } from 'vitest';
import { configuredReviewerRunner } from '../../accessors/reviewer-runner.js';
import { applyCLIOverrides } from './apply.js';
import { workflowOptsToCLIOverrides } from './from-options.js';
import type { Config } from '../../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig: Config = makeConfig({ workflow: { approve: 'plan' } });

describe('applyCLIOverrides — plannerEffort', () => {
  it('sets planner.effort when valid', () => {
    const { config: result } = applyCLIOverrides(baseConfig, { plannerEffort: 'high' });
    expect(result.planner.effort).toBe('high');
  });
  it('accepts max, the top of the vocabulary', () => {
    const { config: result } = applyCLIOverrides(baseConfig, { plannerEffort: 'max' });
    expect(result.planner.effort).toBe('max');
  });
  it('refuses a level outside the vocabulary and names every level it takes', () => {
    expect(() => applyCLIOverrides(baseConfig, { plannerEffort: 'turbo' })).toThrow(
      'Must be one of: off, none, minimal, low, medium, high, xhigh, max, ultra',
    );
  });
  it('leaves config untouched when override absent', () => {
    const { config: result } = applyCLIOverrides(baseConfig, {});
    expect(result.planner.effort).toBeUndefined();
  });
});

describe('applyCLIOverrides — contextLength', () => {
  it('applies contextLength override', () => {
    const { config: result } = applyCLIOverrides(baseConfig, { contextLength: 16384 });
    expect(result.implementer.contextLength).toBe(16384);
  });

  it('preserves a configured approve level when no approve override is given', () => {
    const config: Config = { ...baseConfig, workflow: { ...baseConfig.workflow, approve: 'none' } };
    expect(applyCLIOverrides(config, {}).config.workflow.approve).toBe('none');
  });
});

describe('workflowOptsToCLIOverrides with SPLITBRIEF_CONTEXT_LENGTH', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sets the Prompt budget of the default implementer profile', () => {
    vi.stubEnv('SPLITBRIEF_CONTEXT_LENGTH', '4096');
    expect(
      applyCLIOverrides(baseConfig, workflowOptsToCLIOverrides({})).config.implementer
        .contextLength,
    ).toBe(4096);
  });

  it('lets the --implementer-context-length flag win over it', () => {
    vi.stubEnv('SPLITBRIEF_CONTEXT_LENGTH', '4096');
    expect(
      applyCLIOverrides(baseConfig, workflowOptsToCLIOverrides({ implementerContextLength: 8192 }))
        .config.implementer.contextLength,
    ).toBe(8192);
  });
});

describe('applyCLIOverrides — the reviewer seat', () => {
  it('--reviewer codex --reviewer-model <id> writes reviewer and leaves planner untouched', () => {
    const { config: result } = applyCLIOverrides(
      baseConfig,
      workflowOptsToCLIOverrides({ reviewer: 'codex', reviewerModel: 'gpt-5.4' }),
    );

    expect(result.reviewer).toMatchObject({ kind: 'cli', tool: 'codex', model: 'gpt-5.4' });
    expect(result.planner).toEqual(baseConfig.planner);
  });

  it('leaves reviewer unset when no reviewer flag is given', () => {
    expect(
      applyCLIOverrides(baseConfig, workflowOptsToCLIOverrides({})).config.reviewer,
    ).toBeUndefined();
  });

  it('--reviewer-effort applies to the reviewer seat, not the planner', () => {
    const { config: result } = applyCLIOverrides(
      baseConfig,
      workflowOptsToCLIOverrides({ reviewer: 'codex', reviewerEffort: 'high' }),
    );

    expect(configuredReviewerRunner(result)?.effort).toBe('high');
    expect(result.planner.effort).toBeUndefined();
  });

  it('refuses --reviewer-effort alone rather than forking the inherited seat', () => {
    expect(() =>
      applyCLIOverrides(baseConfig, workflowOptsToCLIOverrides({ reviewerEffort: 'high' })),
    ).toThrow(/inherits the planner; pass --reviewer/);
  });

  it('refuses --reviewer-effort alone while REVIEW is None', () => {
    expect(() =>
      applyCLIOverrides(
        makeConfig({ reviewer: 'none' }),
        workflowOptsToCLIOverrides({ reviewerEffort: 'high' }),
      ),
    ).toThrow('REVIEW is set to None; pass --reviewer to give it a runner first.');
  });
});
