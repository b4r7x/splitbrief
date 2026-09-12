import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { withAutoRouteProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  admitAutoRouteRows,
  autoRouteFallbackChecks,
  derivedAutoRouteProfiles,
  type EvaluatedSlot,
} from './auto-route-admission.js';
import { admittedCheck, blockedCheck, type RunnerCandidate } from './runner-candidates.js';

const autoCheapestConfig: Config = {
  ...createDefaultConfig(),
  implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' },
};

const priced = [
  {
    config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro' },
    pricingInput: 0.25,
    pricingOutput: 1,
  },
  {
    config: { kind: 'cli', tool: 'codex', model: 'gpt-5-mini' },
    pricingInput: 2,
    pricingOutput: 10,
  },
] as const;

function implementerSlot(profile: string, verdict: 'admitted' | 'blocked'): EvaluatedSlot {
  const candidate: RunnerCandidate = {
    slot: { role: 'implementer', profile },
    runner: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro' },
    trustLabel: `implementer profile ${profile}`,
  };
  if (verdict === 'blocked') {
    return {
      candidate,
      evaluation: {
        kind: 'blocked',
        check: blockedCheck(candidate.slot, 'cli', 'kilo-code is not authenticated.'),
      },
    };
  }
  return {
    candidate,
    evaluation: {
      kind: 'admitted',
      check: admittedCheck(candidate.slot, 'cli'),
      gate: {
        kind: 'api',
        provider: 'ollama',
        endpointOrigin: 'http://localhost:11434',
        slot: candidate.slot,
        preparationId: 'preparation-1',
      },
    },
  };
}

function plannerSlot(): EvaluatedSlot {
  const candidate: RunnerCandidate = {
    slot: { role: 'planner' },
    runner: createDefaultConfig().planner,
    trustLabel: 'planner',
  };
  return {
    candidate,
    evaluation: {
      kind: 'blocked',
      check: blockedCheck(candidate.slot, 'cli', 'planner is not authenticated.'),
    },
  };
}

describe('derivedAutoRouteProfiles', () => {
  it('names the rows routing invented and nothing the config declared itself', () => {
    const routed = withAutoRouteProfiles(autoCheapestConfig, [...priced]);

    expect([...derivedAutoRouteProfiles(autoCheapestConfig, routed)]).toEqual(
      Object.keys(routed.implementerProfiles?.profiles ?? {}),
    );
    expect(derivedAutoRouteProfiles(routed, routed).size).toBe(0);
    expect(derivedAutoRouteProfiles(autoCheapestConfig, autoCheapestConfig).size).toBe(0);
  });
});

describe('admitAutoRouteRows', () => {
  const derived = new Set(['auto-cheap', 'auto-pricey']);

  it('drops a blocked derived row and warns instead of blocking the preparation', () => {
    const routing = admitAutoRouteRows({
      evaluated: [
        implementerSlot('auto-cheap', 'admitted'),
        implementerSlot('auto-pricey', 'blocked'),
      ],
      derived,
    });

    expect([...routing.dropped]).toEqual(['auto-pricey']);
    expect(routing.kept.map((slot) => slot.candidate.slot)).toEqual([
      { role: 'implementer', profile: 'auto-cheap' },
    ]);
    const dropped = routing.checks.find((check) => check.severity === 'warning');
    expect(dropped?.summary).toBe(
      'Implementer profile auto-pricey was dropped from price routing.',
    );
    expect(dropped?.details).toEqual(['kilo-code is not authenticated.']);
    expect(routing.checks).toHaveLength(2);
  });

  it('keeps every blocker when no derived row was admitted', () => {
    const routing = admitAutoRouteRows({
      evaluated: [
        implementerSlot('auto-cheap', 'blocked'),
        implementerSlot('auto-pricey', 'blocked'),
      ],
      derived,
    });

    expect(routing.dropped.size).toBe(0);
    expect(routing.kept).toHaveLength(2);
    expect(routing.checks.every((check) => check.severity === 'blocker')).toBe(true);
  });

  it('never relaxes a slot that price routing did not derive', () => {
    const routing = admitAutoRouteRows({
      evaluated: [plannerSlot(), implementerSlot('auto-cheap', 'admitted')],
      derived,
    });

    expect(routing.dropped.size).toBe(0);
    expect(routing.kept).toHaveLength(2);
  });
});

describe('autoRouteFallbackChecks', () => {
  it('warns when the marker is set and routing produced no table', () => {
    const checks = autoRouteFallbackChecks(autoCheapestConfig, autoCheapestConfig);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.severity).toBe('warning');
    expect(checks[0]?.id).toBe('runners.preparation.implementer.auto-cheapest');
  });

  it('stays silent for a routed table and for a seat that names a model', () => {
    const routed = withAutoRouteProfiles(autoCheapestConfig, [...priced]);

    expect(autoRouteFallbackChecks(autoCheapestConfig, routed)).toEqual([]);
    expect(autoRouteFallbackChecks(createDefaultConfig(), createDefaultConfig())).toEqual([]);
  });
});
