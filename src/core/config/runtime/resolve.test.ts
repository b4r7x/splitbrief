import { describe, it, expect } from 'vitest';
import {
  resolveMode,
  resolveApproveLevel,
  resolveEffortLevel,
  blocksSpecGate,
  blocksPlanGate,
} from './resolve.js';
import type { Config } from '../../schemas/config.js';
import type { ApproveLevel, EffortLevel, WorkflowMode } from '../../schemas/enums.js';
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
  it('returns CLI override when present', () => {
    expect(resolveMode({ config: baseConfig('standard'), cliOverride: 'instant' })).toBe('instant');
  });
  it('returns config mode when no override', () => {
    expect(resolveMode({ config: baseConfig('speckit') })).toBe('speckit');
  });
  it('falls back to DEFAULT_WORKFLOW_MODE when config has no mode', () => {
    expect(resolveMode({ config: baseConfig() })).toBe('standard');
  });
});

describe('resolveApproveLevel', () => {
  const cases: Array<[WorkflowMode, ApproveLevel]> = [
    ['instant', 'none'],
    ['quick', 'none'],
    ['standard', 'spec'],
    ['speckit', 'all'],
  ];
  it.each(cases)('returns mode default for %s when no overrides', (mode, expected) => {
    expect(resolveApproveLevel({ mode })).toBe(expected);
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
  it('legacy --auto flag forces "none"', () => {
    expect(
      resolveApproveLevel({
        mode: 'speckit',
        configApprove: 'all',
        cliOverride: 'all',
        legacyAutoFlag: true,
      }),
    ).toBe('none');
  });
  it('CLI "default" falls through to config / mode default', () => {
    expect(resolveApproveLevel({ mode: 'speckit', cliOverride: 'default' })).toBe('all');
    expect(
      resolveApproveLevel({ mode: 'speckit', configApprove: 'plan', cliOverride: 'default' }),
    ).toBe('plan');
  });
});

describe('blocksSpecGate / blocksPlanGate', () => {
  it.each<[ApproveLevel, boolean, boolean]>([
    ['none', false, false],
    ['spec', true, false],
    ['plan', false, true],
    ['all', true, true],
    ['default', false, false],
  ])('%s -> spec=%s plan=%s', (level, spec, plan) => {
    expect(blocksSpecGate(level)).toBe(spec);
    expect(blocksPlanGate(level)).toBe(plan);
  });
});

describe('resolveEffortLevel', () => {
  function withEffort(effort?: EffortLevel): Config {
    const c = baseConfig('standard');
    if (effort) (c.planner as { effort?: EffortLevel }).effort = effort;
    return c;
  }
  it('returns CLI override when present', () => {
    expect(resolveEffortLevel({ config: withEffort('low'), cliOverride: 'high' })).toBe('high');
  });
  it('returns config effort when no override', () => {
    expect(resolveEffortLevel({ config: withEffort('medium') })).toBe('medium');
  });
  it('returns undefined when neither set', () => {
    expect(resolveEffortLevel({ config: withEffort() })).toBeUndefined();
  });
});
