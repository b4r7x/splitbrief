import { describe, expect, it } from 'vitest';
import {
  resolveImplementerProfiles,
  withAutoRouteProfiles,
  type AutoRouteCandidateRow,
} from '../../../core/config/accessors/implementer-profiles.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import type { ImplementerCostTier } from '../../../core/schemas/implementer-config.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { compareProfileRouteRank, costPosture } from './decision.js';
import type { ProfileFit } from './types.js';
import { routeTaskToImplementerProfile } from './route.js';

function profileFit(
  name: string,
  costTier: ImplementerCostTier,
  contextLength: number,
  pricePer1M?: number,
): ProfileFit {
  return {
    profile: {
      name,
      costTier,
      config: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: name,
      },
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: false,
      ...(pricePer1M !== undefined ? { pricePer1M } : {}),
    },
    fit: 'fits',
    estimatedTokens: 1_000,
    untruncatedEstimatedTokens: 1_000,
    contextLength,
    currentCodeTruncated: false,
    currentCodeContextMode: 'none',
    usedConservativeContextLength: false,
    requiredWriteMode: 'extracted-code',
  };
}

function autoCheapestKiloCandidates(): AutoRouteCandidateRow[] {
  return [
    {
      config: {
        kind: 'cli',
        tool: 'kilo-code',
        model: 'kilo/kilo-auto/max',
        contextLength: 200_000,
      },
      pricingInput: 2,
      pricingOutput: 10,
    },
    {
      config: {
        kind: 'cli',
        tool: 'kilo-code',
        model: 'kilo/kilo-auto/pro',
        contextLength: 200_000,
      },
      pricingInput: 0.25,
      pricingOutput: 1,
    },
    {
      config: { kind: 'cli', tool: 'command-code', model: 'deepseek/deepseek-v4.1-flash' },
    },
  ];
}

describe('compareProfileRouteRank', () => {
  it('ranks the cheaper priced profile first even when its cost tier and context are worse', () => {
    const cheaperFrontier = profileFit('frontier-priced', 'frontier', 100_000, 4.25);
    const priceyLocal = profileFit('local-priced', 'local', 1_000, 42);

    expect(compareProfileRouteRank(cheaperFrontier, priceyLocal)).toBeLessThan(0);
    expect(compareProfileRouteRank(priceyLocal, cheaperFrontier)).toBeGreaterThan(0);
  });

  it('falls through to cost tier when both priced profiles cost the same', () => {
    const local = profileFit('local-same-price', 'local', 10_000, 5);
    const cheap = profileFit('cheap-same-price', 'cheap', 10_000, 5);

    expect(compareProfileRouteRank(local, cheap)).toBeLessThan(0);
    expect(compareProfileRouteRank(cheap, local)).toBeGreaterThan(0);
  });

  it('ranks an unpriced profile ahead of every priced one, whatever its cost tier', () => {
    const pricedFrontier = profileFit('priced-frontier', 'frontier', 100_000, 1);
    const unpricedLocal = profileFit('unpriced-local', 'local', 1_000);
    const unpricedFrontier = profileFit('unpriced-frontier', 'frontier', 1_000);
    const pricedLocal = profileFit('priced-local', 'local', 100_000, 1);

    expect(compareProfileRouteRank(unpricedLocal, pricedFrontier)).toBeLessThan(0);
    expect(compareProfileRouteRank(pricedFrontier, unpricedLocal)).toBeGreaterThan(0);
    expect(compareProfileRouteRank(unpricedFrontier, pricedLocal)).toBeLessThan(0);
    expect(compareProfileRouteRank(pricedLocal, unpricedFrontier)).toBeGreaterThan(0);
  });

  it('stays a total order over a mixed priced and unpriced set', () => {
    const pricedFrontier = profileFit('priced-frontier', 'frontier', 100_000, 1);
    const unpricedStandard = profileFit('unpriced-standard', 'standard', 10_000);
    const priceyLocal = profileFit('pricey-local', 'local', 1_000, 10);

    // Every input order must rank the same way, which an intransitive
    // comparator cannot do.
    for (const permutation of [
      [pricedFrontier, unpricedStandard, priceyLocal],
      [pricedFrontier, priceyLocal, unpricedStandard],
      [unpricedStandard, pricedFrontier, priceyLocal],
      [unpricedStandard, priceyLocal, pricedFrontier],
      [priceyLocal, pricedFrontier, unpricedStandard],
      [priceyLocal, unpricedStandard, pricedFrontier],
    ]) {
      const ranked = permutation.toSorted(compareProfileRouteRank);
      expect(ranked.map((fit) => fit.profile.name)).toEqual([
        'unpriced-standard',
        'priced-frontier',
        'pricey-local',
      ]);
    }
  });

  it('keeps the cost-tier then context-length order when neither profile is priced', () => {
    const localSmall = profileFit('local-small', 'local', 1_000);
    const localLarge = profileFit('local-large', 'local', 10_000);
    const cheapLarge = profileFit('cheap-large', 'cheap', 100_000);

    expect(compareProfileRouteRank(localSmall, localLarge)).toBeLessThan(0);
    expect(compareProfileRouteRank(localLarge, cheapLarge)).toBeLessThan(0);
  });
});

describe('costPosture', () => {
  it('reports the blended price for a priced selection', () => {
    expect(costPosture(profileFit('kilo-pro', 'unknown', 200_000, 4.25), [])).toBe(
      'Selected cheapest priced profile at $4.25/1M blended via auto-cheapest routing',
    );
  });

  it('keeps the cheapest-capable posture string for unpriced selections', () => {
    const selected = profileFit('local-small', 'local', 10_000);
    const rejected = profileFit('local-large', 'local', 20_000);

    expect(costPosture(selected, [rejected])).toBe(
      'Selected local cost tier via cheapest-capable routing; rejected tiers: local',
    );
  });
});

describe('routeTaskToImplementerProfile', () => {
  it('auto:cheapest routes a small task to the cheaper priced kilo row and never to the unpriced cmd row', () => {
    const candidates = [
      {
        config: {
          kind: 'cli',
          tool: 'kilo-code',
          model: 'kilo/kilo-auto/pro',
          contextLength: 200_000,
        },
        pricingInput: 0.25,
        pricingOutput: 1,
      },
      {
        config: {
          kind: 'cli',
          tool: 'kilo-code',
          model: 'kilo/kilo-auto/max',
          contextLength: 200_000,
        },
        pricingInput: 2,
        pricingOutput: 10,
      },
      {
        config: { kind: 'cli', tool: 'command-code', model: 'deepseek/deepseek-v4.1-flash' },
      },
    ] satisfies readonly AutoRouteCandidateRow[];
    const { profiles } = resolveImplementerProfiles(
      withAutoRouteProfiles(
        {
          ...createDefaultConfig(),
          implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' },
        },
        candidates,
      ),
    );
    const decision = routeTaskToImplementerProfile({
      task: makeTask(),
      context: { name: 'test-project', dir: '/repo' } satisfies ProjectContext,
      profiles,
    });

    expect(profiles).toHaveLength(2);
    expect(
      profiles.some(
        (profile) => profile.config.kind === 'cli' && profile.config.tool === 'command-code',
      ),
    ).toBe(false);
    expect(decision.selectedProfile).toBe(
      profiles.find((profile) => profile.config.model === 'kilo/kilo-auto/pro')?.name,
    );
    expect(decision.costPosture).toContain('$4.25/1M');
    expect(decision.fit).not.toBe('overflow');
  });

  it('still selects the cheaper kilo row when the priced candidates are swapped', () => {
    const { profiles } = resolveImplementerProfiles(
      withAutoRouteProfiles(
        {
          ...createDefaultConfig(),
          implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' },
        },
        autoCheapestKiloCandidates(),
      ),
    );
    const decision = routeTaskToImplementerProfile({
      task: makeTask(),
      context: { name: 'test-project', dir: '/repo' } satisfies ProjectContext,
      profiles,
    });

    expect(decision.selectedProfile).toBe(
      profiles.find((profile) => profile.config.model === 'kilo/kilo-auto/pro')?.name,
    );
  });
});
