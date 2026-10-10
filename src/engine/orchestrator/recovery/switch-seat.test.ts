import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { ConfigSchema } from '../../../core/schemas/config.js';
import { seatRunnerValue } from './actions.js';
import { routeTaskToImplementerProfile } from '../context-routing/route.js';
import { selectedProfileFromDecision } from '../task/routing.js';
import { configWithSwitchedSeat } from './switch-seat.js';

function smallDefaultBigProfileConfig() {
  return makeConfig({
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'small',
      apiBase: 'http://localhost:11434/v1',
      contextLength: 1_000,
    },
    implementerProfiles: {
      default: 'small',
      profiles: {
        small: {
          kind: 'api',
          provider: 'ollama',
          model: 'small',
          apiBase: 'http://localhost:11434/v1',
          contextLength: 1_000,
          label: 'Small',
        },
        big: { kind: 'cli', tool: 'codex', label: 'Big' },
      },
    },
  });
}

describe('configWithSwitchedSeat', () => {
  it('uses the same default BUILD profile for its identity and its switched block', () => {
    const config = smallDefaultBigProfileConfig();
    const profiles = config.implementerProfiles;
    if (profiles === undefined) throw new Error('expected a profile table');
    const withBigDefault = { ...config, implementerProfiles: { ...profiles, default: 'big' } };
    expect(seatRunnerValue(withBigDefault, 'build', undefined)).toEqual(profiles.profiles.big);
    const switched = configWithSwitchedSeat(
      withBigDefault,
      'build',
      { tool: 'opencode' },
      undefined,
      true,
    );
    expect(switched?.implementer.fallback).toEqual({ tool: 'codex' });
    expect(switched?.implementerProfiles?.profiles.big).toMatchObject({
      label: 'Big',
      fallback: { tool: 'codex' },
    });
  });

  it('refuses a missing BUILD profile identity instead of naming the implementer mirror', () => {
    const config = smallDefaultBigProfileConfig();
    expect(() => seatRunnerValue(config, 'build', 'missing')).toThrow('missing');
    expect(configWithSwitchedSeat(config, 'build', { tool: 'opencode' }, 'missing')).toBeNull();
  });

  describe.each(['plan', 'build', 'review'] as const)('automatic %s switch', (seat) => {
    it.each([
      {
        name: 'drops an effort field OpenCode does not spend',
        runner: { kind: 'cli', tool: 'opencode', model: 'provider/model', effort: 'high' },
        fallback: { tool: 'opencode', model: 'provider/model' },
      },
      {
        name: 'keeps the OpenCode variant',
        runner: { kind: 'cli', tool: 'opencode', model: 'provider/model', variant: 'high' },
        fallback: { tool: 'opencode', model: 'provider/model', variant: 'high' },
      },
      {
        name: 'keeps only the OpenCode variant when both level fields are stored',
        runner: {
          kind: 'cli',
          tool: 'opencode',
          model: 'provider/model',
          effort: 'low',
          variant: 'high',
        },
        fallback: { tool: 'opencode', model: 'provider/model', variant: 'high' },
      },
      {
        name: 'keeps Claude max effort',
        runner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
        fallback: { tool: 'claude-code', model: 'opus', effort: 'max' },
      },
      {
        name: 'keeps model-id axes in the model alone',
        runner: { kind: 'cli', tool: 'cursor', model: 'sonnet-high', effort: 'high' },
        fallback: { tool: 'cursor', model: 'sonnet-high' },
      },
    ] as const)('$name', ({ runner, fallback }) => {
      const existing = { ...runner, fallback: { tool: 'codex' } };
      const config = makeConfig({ planner: existing, implementer: existing, reviewer: existing });
      const switched = configWithSwitchedSeat(config, seat, { tool: 'codex' }, undefined, true);
      expect(switched).not.toBeNull();
      if (switched === null) throw new Error('expected an automatic switch');
      expect(seatRunnerValue(switched, seat, undefined)).toEqual({
        kind: 'cli',
        tool: 'codex',
        fallback,
      });
      expect(ConfigSchema.safeParse(switched).success).toBe(true);
    });

    it('returns null when the complete switched runner fails validation', () => {
      const runner = { kind: 'cli', tool: 'codex', model: '' } as const;
      const config = { ...makeConfig(), planner: runner, implementer: runner, reviewer: runner };
      expect(
        configWithSwitchedSeat(config, seat, { tool: 'opencode' }, undefined, true),
      ).toBeNull();
    });
  });

  it('swaps the old CLI seat into the fallback slot on an automatic switch', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5-codex',
        effort: 'high',
        fallback: { tool: 'opencode', model: 'provider/model' },
      },
    });
    const switched = configWithSwitchedSeat(
      config,
      'build',
      { tool: 'opencode', model: 'provider/model' },
      undefined,
      true,
    );
    expect(switched?.implementer.fallback).toEqual({
      tool: 'codex',
      model: 'gpt-5-codex',
      effort: 'high',
    });
  });

  it('leaves no fallback when an automatic switch leaves an API seat', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'small',
        fallback: { tool: 'opencode' },
      },
    });
    const switched = configWithSwitchedSeat(config, 'build', { tool: 'opencode' }, undefined, true);
    expect(switched?.implementer).toEqual({ kind: 'cli', tool: 'opencode' });
  });

  it('keeps an explicit reviewer with no fallback without one on a manual switch', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
      reviewer: { kind: 'cli', tool: 'codex' },
    });
    const switched = configWithSwitchedSeat(config, 'review', { tool: 'opencode' });
    expect(switched?.reviewer).toEqual({ kind: 'cli', tool: 'opencode' });
    expect(switched?.planner).toEqual(config.planner);
  });

  it('swaps only the failing profile and preserves its metadata on an automatic switch', () => {
    const config = smallDefaultBigProfileConfig();
    const switched = configWithSwitchedSeat(config, 'build', { tool: 'opencode' }, 'big', true);
    expect(switched?.implementerProfiles?.profiles.big).toEqual({
      kind: 'cli',
      tool: 'opencode',
      label: 'Big',
      fallback: { tool: 'codex' },
    });
    expect(switched?.implementer).toEqual(config.implementer);
  });
  it('repoints one seat and leaves the others alone', () => {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });

    const switched = configWithSwitchedSeat(config, 'build', {
      tool: 'claude-code',
      model: 'sonnet',
    });

    expect(switched?.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
    expect(switched?.planner).toEqual(config.planner);
  });

  it("carries the picker's effort and variant into the runner block", () => {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });

    const switched = configWithSwitchedSeat(config, 'build', {
      tool: 'claude-code',
      model: 'sonnet',
      effort: 'high',
      variant: 'thinking',
    });

    expect(switched?.implementer).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
      effort: 'high',
      variant: 'thinking',
    });
  });

  it('repoints the default profile the build seat is routed out of', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex' },
      implementerProfiles: {
        default: 'cheap',
        profiles: {
          cheap: { kind: 'cli', tool: 'codex', label: 'Cheap' },
          big: { kind: 'cli', tool: 'opencode' },
        },
      },
    });

    const switched = configWithSwitchedSeat(config, 'build', { tool: 'claude-code' });

    expect(switched).not.toBeNull();
    if (switched === null) return;
    expect(resolveImplementerProfiles(switched).defaultProfile.config).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
    });
    expect(switched.implementerProfiles?.profiles.big).toMatchObject({ tool: 'opencode' });
  });

  it('repoints the failing non-default profile, and the next routed retry lands on the replacement', () => {
    const config = smallDefaultBigProfileConfig();

    const switched = configWithSwitchedSeat(
      config,
      'build',
      { tool: 'claude-code', model: 'sonnet' },
      'big',
    );

    expect(switched).not.toBeNull();
    if (switched === null) return;
    expect(switched.implementerProfiles?.profiles.big).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
      label: 'Big',
    });
    expect(switched.implementerProfiles?.profiles.small).toEqual(
      config.implementerProfiles?.profiles.small,
    );
    expect(switched.implementer).toEqual(config.implementer);

    const profiles = resolveImplementerProfiles(switched).profiles;
    const decision = routeTaskToImplementerProfile({
      task: makeTask({ description: 'a brief too large for the small worker '.repeat(300) }),
      context: { name: 'test-project', dir: '/repo' },
      profiles,
    });
    expect(decision.selectedProfile).toBe('big');
    expect(selectedProfileFromDecision(profiles, decision)?.config).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
  });

  it('keeps the implementer mirror in step when the failing profile is the default', () => {
    const config = smallDefaultBigProfileConfig();

    const switched = configWithSwitchedSeat(config, 'build', { tool: 'claude-code' }, 'small');

    expect(switched?.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
    expect(switched?.implementerProfiles?.profiles.small).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      label: 'Small',
    });
    expect(switched?.implementerProfiles?.profiles.big).toEqual(
      config.implementerProfiles?.profiles.big,
    );
  });

  it('rejects a failing profile the table does not carry', () => {
    const config = smallDefaultBigProfileConfig();

    expect(configWithSwitchedSeat(config, 'build', { tool: 'claude-code' }, 'huge')).toBeNull();
    expect(configWithSwitchedSeat(config, 'build', { tool: 'claude-code' }, 'toString')).toBeNull();
  });

  it('swaps the single implementer when the config has no profile table', () => {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });

    const switched = configWithSwitchedSeat(config, 'build', { tool: 'claude-code' }, 'default');

    expect(switched?.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
    expect(switched?.implementerProfiles).toBeUndefined();
  });

  it('rejects a tool the seat cannot host', () => {
    const config = makeConfig();

    expect(configWithSwitchedSeat(config, 'plan', { tool: 'not-a-real-tool' })).toBeNull();
  });

  it('keeps the plan seat fallback across the switch', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });

    const switched = configWithSwitchedSeat(config, 'plan', { tool: 'opencode' });

    expect(switched?.planner.fallback).toEqual({ tool: 'codex' });
  });

  it('keeps the build seat fallback across the switch', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
    });

    const switched = configWithSwitchedSeat(config, 'build', { tool: 'opencode' });

    expect(switched?.implementer.fallback).toEqual({ tool: 'claude-code' });
  });

  it('gives an inherited review seat the planner fallback', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });

    const switched = configWithSwitchedSeat(config, 'review', { tool: 'opencode' });

    expect(switched?.reviewer?.fallback).toEqual({ tool: 'codex' });
    expect(switched?.planner).toEqual(config.planner);
  });
});
