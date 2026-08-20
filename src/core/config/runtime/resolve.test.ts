import { describe, it, expect } from 'vitest';
import {
  resolveMode,
  resolveApproveLevel,
  resolveEffortLevel,
  blocksSpecGate,
  blocksPlanGate,
} from './resolve.js';
import type { Config } from '../../schemas/config.js';
import type { EffortLevel, WorkflowMode } from '../../schemas/enums.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig = (mode?: WorkflowMode): Config =>
  makeConfig({
    workflow: {
      approve: 'default',
      ...(mode ? { mode } : {}),
      git: { commitStrategy: 'none' },
      speckit: { minCoverage: 0.9 },
    },
  });

describe('resolveMode', () => {
  it.each([
    {
      description: 'returns CLI override when present',
      input: { config: baseConfig('standard'), cliOverride: 'instant' as const },
      expected: 'instant' as const,
    },
    {
      description: 'returns config mode when no override',
      input: { config: baseConfig('speckit') },
      expected: 'speckit' as const,
    },
    {
      description: 'falls back to DEFAULT_WORKFLOW_MODE when config has no mode',
      input: { config: baseConfig() },
      expected: 'standard' as const,
    },
    {
      description: 'prefers a saved mode over the config default',
      input: { config: baseConfig('standard'), savedMode: 'speckit' as const },
      expected: 'speckit' as const,
    },
    {
      description: 'CLI override beats a saved mode',
      input: {
        config: baseConfig('standard'),
        savedMode: 'speckit' as const,
        cliOverride: 'instant' as const,
      },
      expected: 'instant' as const,
    },
  ])('$description', ({ input, expected }) => {
    expect(resolveMode(input)).toBe(expected);
  });
});

describe('resolveApproveLevel', () => {
  it.each([
    { description: 'instant', input: { mode: 'instant' as const }, expected: 'none' as const },
    { description: 'quick', input: { mode: 'quick' as const }, expected: 'none' as const },
    { description: 'standard', input: { mode: 'standard' as const }, expected: 'spec' as const },
    { description: 'speckit', input: { mode: 'speckit' as const }, expected: 'all' as const },
  ])('returns mode default for $description when no overrides', ({ input, expected }) => {
    expect(resolveApproveLevel(input)).toBe(expected);
  });
  it('returns mode default when configApprove is "default"', () => {
    expect(resolveApproveLevel({ mode: 'standard', configApprove: 'default' })).toBe('spec');
  });
  it('CLI override beats config and mode default', () => {
    expect(
      resolveApproveLevel({ mode: 'speckit', configApprove: 'spec', cliOverride: 'none' }),
    ).toBe('none');
  });
  it('config approve beats mode default when CLI omitted', () => {
    expect(resolveApproveLevel({ mode: 'speckit', configApprove: 'plan' })).toBe('plan');
  });
  it('CLI "default" falls through to config / mode default', () => {
    expect(resolveApproveLevel({ mode: 'speckit', cliOverride: 'default' })).toBe('all');
    expect(
      resolveApproveLevel({ mode: 'speckit', configApprove: 'plan', cliOverride: 'default' }),
    ).toBe('plan');
  });
  it('saved approve beats mode default when CLI and config omitted', () => {
    expect(resolveApproveLevel({ mode: 'speckit', savedApprove: 'spec' })).toBe('spec');
  });
  it('config approve beats saved approve', () => {
    expect(
      resolveApproveLevel({ mode: 'speckit', configApprove: 'plan', savedApprove: 'spec' }),
    ).toBe('plan');
  });
});

describe('blocksSpecGate / blocksPlanGate', () => {
  it.each([
    { description: 'none', input: 'none' as const, expectedSpec: false, expectedPlan: false },
    { description: 'spec', input: 'spec' as const, expectedSpec: true, expectedPlan: false },
    { description: 'plan', input: 'plan' as const, expectedSpec: false, expectedPlan: true },
    { description: 'all', input: 'all' as const, expectedSpec: true, expectedPlan: true },
    { description: 'default', input: 'default' as const, expectedSpec: false, expectedPlan: false },
  ])(
    '$description -> spec=$expectedSpec plan=$expectedPlan',
    ({ input, expectedSpec, expectedPlan }) => {
      expect(blocksSpecGate(input)).toBe(expectedSpec);
      expect(blocksPlanGate(input)).toBe(expectedPlan);
    },
  );
});

describe('resolveEffortLevel', () => {
  function withEffort(effort?: EffortLevel): Config {
    const c = baseConfig('standard');
    if (effort) (c.planner as { effort?: EffortLevel }).effort = effort;
    return c;
  }
  it.each([
    {
      description: 'returns CLI override when present',
      configEffort: 'low' as const,
      cliOverride: 'high' as const,
      expected: 'high' as const,
    },
    {
      description: 'returns config effort when no override',
      configEffort: 'medium' as const,
      cliOverride: undefined,
      expected: 'medium' as const,
    },
    {
      description: 'returns undefined when neither set',
      configEffort: undefined,
      cliOverride: undefined,
      expected: undefined,
    },
  ])('$description', ({ configEffort, cliOverride, expected }) => {
    expect(resolveEffortLevel({ config: withEffort(configEffort), cliOverride })).toBe(expected);
  });
});
