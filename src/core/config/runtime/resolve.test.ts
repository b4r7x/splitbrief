import { describe, it, expect } from 'vitest';
import {
  resolveApproveChecks,
  resolveApproveLevel,
  resolveEffortLevel,
  resolveEndChecks,
} from './resolve.js';
import type { Config } from '../../schemas/config.js';
import type { EffortLevel } from '../../schemas/enums.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig = (): Config =>
  makeConfig({ workflow: { approve: 'plan', git: { commitStrategy: 'none' } } });

describe('resolveApproveLevel', () => {
  it('defaults to the plan card when the config names no level', () => {
    expect(resolveApproveLevel(makeConfig({ workflow: { git: { commitStrategy: 'none' } } }))).toBe(
      'plan',
    );
  });
  it('takes the config level', () => {
    expect(
      resolveApproveLevel(
        makeConfig({ workflow: { approve: 'none', git: { commitStrategy: 'none' } } }),
      ),
    ).toBe('none');
  });
});

describe('resolveEndChecks', () => {
  it('runs the End-of-run checks when the config names no value', () => {
    expect(resolveEndChecks(makeConfig())).toBe(true);
  });
  it('takes the config value', () => {
    expect(resolveEndChecks(makeConfig({ validation: { endChecks: false } }))).toBe(false);
    expect(resolveEndChecks(makeConfig({ validation: { endChecks: true } }))).toBe(true);
  });
});

describe('resolveApproveChecks', () => {
  it('runs the reviewer checks without asking when the config names no value', () => {
    expect(resolveApproveChecks(makeConfig())).toBe('auto');
  });
  it('takes the config value', () => {
    expect(resolveApproveChecks(makeConfig({ validation: { approveChecks: 'ask' } }))).toBe('ask');
    expect(resolveApproveChecks(makeConfig({ validation: { approveChecks: 'auto' } }))).toBe(
      'auto',
    );
  });
});

describe('resolveEffortLevel', () => {
  function withEffort(effort?: EffortLevel): Config {
    const c = baseConfig();
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
