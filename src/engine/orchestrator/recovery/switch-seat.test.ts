import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  resolveImplementerProfiles,
  withAutoRouteProfiles,
} from '../../../core/config/accessors/implementer-profiles.js';
import { configWithSwitchedSeat } from './switch-seat.js';

describe('configWithSwitchedSeat', () => {
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

  it('drops the auto-derived profile table so nothing routes back to the blocked tool', () => {
    const config = withAutoRouteProfiles(
      makeConfig({ implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' } }),
      [
        {
          config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro' },
          pricingInput: 0.25,
          pricingOutput: 1,
        },
      ],
    );
    expect(config.implementerProfiles).toBeDefined();

    const switched = configWithSwitchedSeat(config, 'build', {
      tool: 'claude-code',
      model: 'sonnet',
    });

    expect(switched).not.toBeNull();
    if (switched === null) return;
    expect(switched.implementerProfiles).toBeUndefined();
    expect(resolveImplementerProfiles(switched).defaultProfile.config).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
  });

  it('rejects a tool the seat cannot host', () => {
    const config = makeConfig();

    expect(configWithSwitchedSeat(config, 'plan', { tool: 'not-a-real-tool' })).toBeNull();
  });
});
