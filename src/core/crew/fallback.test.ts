import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { SavedCatalog } from '../discovery/catalog-read-merge.js';
import type { CliToolDetection } from '../discovery/detection.js';
import {
  deriveFallbackRows,
  fallbackBlockedReason,
  fallbackRowKey,
  fallbackRunner,
  FALLBACK_NONE_WORDS,
  seatFallback,
  type FallbackRow,
} from './fallback.js';
import { formatSeatIdentity } from './identity.js';

const READY: readonly CliToolDetection[] = [
  cliDetectionFor('ready', 'codex'),
  cliDetectionFor('ready', 'claude-code'),
  cliDetectionFor('ready', 'opencode'),
];

function rowOf(rows: readonly FallbackRow[], id: FallbackRow['id']): FallbackRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no ${id} fallback row`);
  return row;
}

describe('deriveFallbackRows', () => {
  it('gives every seat one row, keyed fallback:<seat>, in seat order', () => {
    const rows = deriveFallbackRows({ config: makeConfig(), cliTools: READY });

    expect(rows.map(fallbackRowKey)).toEqual([
      'fallback:plan',
      'fallback:build',
      'fallback:review',
    ]);
  });

  it('leaves the fallback, its identity and its note off a seat that sets none', () => {
    for (const row of deriveFallbackRows({ config: makeConfig(), cliTools: READY })) {
      expect(row.fallback).toBeUndefined();
      expect(row.identity).toBeUndefined();
      expect(row.note).toBeUndefined();
    }
  });

  it('spells a set fallback the way the seat it moves to is spelled', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
        fallback: { tool: 'codex', model: 'gpt-5', effort: 'high' },
      },
    });

    const plan = rowOf(deriveFallbackRows({ config, cliTools: READY }), 'plan');

    expect(plan.fallback).toEqual({ tool: 'codex', model: 'gpt-5', effort: 'high' });
    expect(plan.identity).toBe(
      formatSeatIdentity({ seat: { kind: 'cli', tool: 'codex', model: 'gpt-5', effort: 'high' } }),
    );
    expect(plan.note).toBeUndefined();
  });

  it('states the variant axis word once', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
        fallback: { tool: 'opencode', model: 'openai/gpt-5.6', variant: 'xhigh' },
      },
    });

    const plan = rowOf(deriveFallbackRows({ config, cliTools: READY }), 'plan');

    expect(plan.identity?.endsWith('xhigh')).toBe(true);
    expect(plan.identity?.match(/xhigh/g)).toHaveLength(1);
  });

  it('states model-id axes once, outside the model word', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        fallback: { tool: 'cursor', model: 'claude-opus-5-thinking-xhigh-fast' },
      },
    });

    const build = rowOf(deriveFallbackRows({ config, cliTools: READY }), 'build');

    expect(build.identity).toBe(
      formatSeatIdentity({
        seat: { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-xhigh-fast' },
      }),
    );
    for (const word of ['xhigh', 'thinking', 'fast']) {
      expect(build.identity?.split(word)).toHaveLength(2);
    }
  });

  it("gives an inherited review seat the planner's fallback and marks it inherited", () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });

    const rows = deriveFallbackRows({ config, cliTools: READY });

    expect(rowOf(rows, 'review')).toMatchObject({ inherited: true, fallback: { tool: 'codex' } });
    expect(rowOf(rows, 'plan').inherited).toBe(false);
  });

  it('gives a review seat with its own block its own fallback, never the planner one', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    });

    const review = rowOf(deriveFallbackRows({ config, cliTools: READY }), 'review');

    expect(review.inherited).toBe(false);
    expect(review.fallback).toBeUndefined();
  });

  it('names why a halt would not take a fallback whose tool the last pass cannot run', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        fallback: { tool: 'opencode', model: 'openai/gpt-5.6' },
      },
    });

    const missing = rowOf(
      deriveFallbackRows({ config, cliTools: [cliDetectionFor('ready', 'codex')] }),
      'build',
    );
    const unavailable = rowOf(
      deriveFallbackRows({ config, cliTools: [cliDetectionFor('unavailable', 'opencode')] }),
      'build',
    );
    const signedOut = rowOf(
      deriveFallbackRows({ config, cliTools: [cliDetectionFor('unauthenticated', 'opencode')] }),
      'build',
    );

    expect(missing.note).toBe('not installed');
    expect(unavailable.note).toBe('not installed');
    expect(signedOut.note).toBe('unauthenticated');
  });

  it('notes a fallback that names the identity the seat already runs', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        fallback: { tool: 'codex', model: 'gpt-5', effort: 'low' },
      },
    });

    expect(rowOf(deriveFallbackRows({ config, cliTools: READY }), 'build').note).toBe(
      'same as the seat',
    );
  });

  it('offers an unverified fallback without a blocked note', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });

    const rows = deriveFallbackRows({ config, cliTools: [cliDetectionFor('unverified', 'codex')] });

    expect(rowOf(rows, 'plan').note).toBeUndefined();
  });

  it('names the current identity before its readiness state, including automatic aliases', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
        fallback: { tool: 'claude-code', model: 'default' },
      },
    });

    expect(rowOf(deriveFallbackRows({ config, cliTools: [] }), 'plan').note).toBe(
      'same as the seat',
    );
  });
});

describe('deriveFallbackRows on a fallback tool that stores no credential', () => {
  const config = makeConfig({
    implementer: {
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5',
      fallback: { tool: 'opencode', model: 'ollama/llama3' },
    },
  });
  const cliTools = [
    cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
  ];
  const listing =
    (ids: readonly string[]) =>
    (tool: string): SavedCatalog | undefined =>
      tool === 'opencode' ? { models: ids.map((id) => ({ id })) } : undefined;

  it('offers it on a model its model list serves', () => {
    const rows = deriveFallbackRows({ config, cliTools, cliCatalog: listing(['ollama/llama3']) });

    expect(rowOf(rows, 'build').note).toBeUndefined();
  });

  it('names it signed out when its model list does not serve the model or was not read', () => {
    const unserved = deriveFallbackRows({
      config,
      cliTools,
      cliCatalog: listing(['lmstudio/qwen3']),
    });
    const unread = deriveFallbackRows({ config, cliTools });

    expect(rowOf(unserved, 'build').note).toBe('unauthenticated');
    expect(rowOf(unread, 'build').note).toBe('unauthenticated');
  });

  it.each([undefined, 'auto'])(
    'reads a fallback on model %s against the model the tool selects on this host',
    (model) => {
      const autoConfig = makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5',
          fallback: { tool: 'opencode', ...(model !== undefined && { model }) },
        },
      });
      const selecting = [
        {
          ...cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
          selectedModel: 'ollama/llama3',
        },
      ];

      const served = deriveFallbackRows({
        config: autoConfig,
        cliTools: selecting,
        cliCatalog: listing(['ollama/llama3']),
      });
      const unselected = deriveFallbackRows({
        config: autoConfig,
        cliTools,
        cliCatalog: listing(['ollama/llama3']),
      });

      expect(rowOf(served, 'build').note).toBeUndefined();
      expect(rowOf(unselected, 'build').note).toBe('unauthenticated');
    },
  );
});

describe('seatFallback', () => {
  it('reads BUILD from the default profile rather than the implementer mirror or another profile', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      implementerProfiles: {
        default: 'active',
        profiles: {
          active: { kind: 'cli', tool: 'codex', fallback: { tool: 'opencode' } },
          dormant: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
        },
      },
    });

    expect(seatFallback(config, 'implementer')).toEqual({ tool: 'opencode' });
    expect(rowOf(deriveFallbackRows({ config, cliTools: READY }), 'build').fallback).toEqual({
      tool: 'opencode',
    });
  });

  it('uses one spelling for an absent fallback', () => {
    expect(FALLBACK_NONE_WORDS).toBe('none · pause and ask');
  });
});

describe('fallbackBlockedReason', () => {
  const codex = { tool: 'codex' };

  it('offers a ready or unverified tool, the same states the halt offers', () => {
    expect(fallbackBlockedReason(codex, cliDetectionFor('ready', 'codex'), undefined)).toBe(
      undefined,
    );
    expect(fallbackBlockedReason(codex, cliDetectionFor('unverified', 'codex'), undefined)).toBe(
      undefined,
    );
  });

  it('reads an absent or unavailable tool as not installed and names every other state', () => {
    expect(fallbackBlockedReason(codex, undefined, undefined)).toBe('not installed');
    expect(fallbackBlockedReason(codex, cliDetectionFor('unavailable', 'codex'), undefined)).toBe(
      'not installed',
    );
    expect(fallbackBlockedReason(codex, cliDetectionFor('incompatible', 'codex'), undefined)).toBe(
      'incompatible',
    );
  });

  describe.each(['ready', 'unverified'] as const)(
    'on a %s tool signed in to another provider',
    (state) => {
      const fallback = { tool: 'opencode', model: 'ollama-cloud/glm-5' };
      const opencode = cliDetectionFor(state, 'opencode', {
        providerAuth: {
          kind: 'read',
          facts: [{ id: 'anthropic', provider: 'Anthropic', source: 'oauth' }],
        },
      });
      const listing = (ids: readonly string[]): SavedCatalog => ({
        models: ids.map((id) => ({ id })),
      });

      it('names the route needs sign-in when its model list was read and does not serve the route', () => {
        expect(
          fallbackBlockedReason(fallback, opencode, listing(['anthropic/claude-sonnet-4'])),
        ).toBe('needs sign-in');
      });

      it('offers it when its model list serves the route or was not read', () => {
        expect(
          fallbackBlockedReason(fallback, opencode, listing(['ollama-cloud/glm-5'])),
        ).toBeUndefined();
        expect(fallbackBlockedReason(fallback, opencode, undefined)).toBeUndefined();
      });

      it('gives the Settings row the same note', () => {
        const config = makeConfig({
          implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5', fallback },
        });

        const rows = deriveFallbackRows({
          config,
          cliTools: [opencode],
          cliCatalog: () => listing(['anthropic/claude-sonnet-4']),
        });

        expect(rowOf(rows, 'build').note).toBe('needs sign-in');
      });
    },
  );
});

describe('fallbackRunner', () => {
  it('lifts a fallback into the cli runner the picker edits, carrying only its own fields', () => {
    expect(fallbackRunner({ tool: 'opencode', model: 'openai/gpt-5.6', variant: 'high' })).toEqual({
      kind: 'cli',
      tool: 'opencode',
      model: 'openai/gpt-5.6',
      variant: 'high',
    });
    expect(fallbackRunner({ tool: 'codex' })).toEqual({ kind: 'cli', tool: 'codex' });
  });

  it('does not lift a tool outside the CLI catalog', () => {
    expect(fallbackRunner({ tool: 'ollama' })).toBeUndefined();
  });
});
