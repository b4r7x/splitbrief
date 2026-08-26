import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOFT_SEP } from '../../../components/separators.js';
import { AUTOMATIC_MODEL } from '../../../core/providers/automatic-model.js';
import type { ModelOption, ModelVariant } from './recency.js';
import type { RightRow } from './rows.js';
import { buildRightRows, rightRowKey, routeAuthStateFor, sectionOf } from './rows.js';

const BASE = {
  expandedModelId: null,
  providerAuth: undefined,
  hasOracle: false,
  catalogLane: 'ready',
  persistedModel: undefined,
  customModels: [],
} as const;

function modelRows(rows: readonly RightRow[]) {
  return rows.filter((row) => row.kind === 'model');
}

function sections(rows: readonly RightRow[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    const section = sectionOf(row);
    if (section !== undefined && !seen.includes(section)) seen.push(section);
  }
  return seen;
}

const auto: ModelOption = { id: AUTOMATIC_MODEL };

function alias(id: string): ModelOption {
  return { id, membership: 'bundled-suggestion' };
}

function catalogModel(id: string, releaseDate?: string): ModelOption {
  return { id, membership: 'catalog-suggestion', ...(releaseDate ? { releaseDate } : {}) };
}

describe('buildRightRows', () => {
  it('leaves a short list unsectioned and still words every row provenance', () => {
    const rows = buildRightRows({
      ...BASE,
      models: [auto, alias('Opus'), alias('OpusPlan'), alias('Sonnet')],
    });

    expect(sections(rows)).toEqual([]);
    expect(modelRows(rows).map((row) => row.provenance)).toEqual([
      'Default',
      'Known',
      'Known',
      'Known',
    ]);
  });

  it('sections a long list with the automatic row pinned above every section', () => {
    const catalog = Array.from({ length: 10 }, (_, index) =>
      catalogModel(`anthropic/claude-catalog-${index}`, `2026-01-${String(index + 10)}`),
    );
    const rows = buildRightRows({
      ...BASE,
      models: [auto, alias('Opus'), alias('OpusPlan'), alias('Sonnet'), ...catalog],
    });

    const first = rows[0];
    expect(first?.kind).toBe('model');
    expect(first?.kind === 'model' && first.model.id).toBe(AUTOMATIC_MODEL);
    expect(first === undefined ? undefined : sectionOf(first)).toBeUndefined();
    expect(sections(rows)).toEqual([
      ['Known aliases', '3'].join(SOFT_SEP),
      ['Catalog', 'Anthropic', '10'].join(SOFT_SEP),
    ]);
  });

  it('opens a kilo-shaped list on the configured section and groups the rest by provider', () => {
    const ids = readFileSync(
      join(import.meta.dirname, '../../../../testing/fixtures/kilo-models-7.0.49.txt'),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim() !== '');
    const persistedModel = ids[4];
    const models: ModelOption[] = ids.map((id) => ({
      id,
      membership: 'confirmed',
      isDetected: true,
    }));

    const rows = buildRightRows({ ...BASE, models, persistedModel });
    const seen = sections(rows);
    const kilo = ['Detected', 'Kilo', '19'].join(SOFT_SEP);
    const openai = ['Detected', 'OpenAI', '37'].join(SOFT_SEP);

    expect(models).toHaveLength(126);
    expect(seen[0]).toBe('Configured');
    expect(seen).toContain(kilo);
    expect(seen).toContain(openai);
    expect(seen.indexOf(kilo)).toBeLessThan(seen.indexOf(openai));

    const placed = modelRows(rows);
    expect(placed).toHaveLength(126);
    expect(new Set(placed.map((row) => row.model.id)).size).toBe(126);
    expect(new Set(placed.map((row) => `${row.model.id} ${row.section}`)).size).toBe(126);
  });

  it('inserts one route row per variant directly under the expanded model', () => {
    const variants: ModelVariant[] = [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model: ModelOption = { id: 'openai/gpt-5.6', membership: 'confirmed', variants };

    const rows = buildRightRows({
      ...BASE,
      models: [auto, model, catalogModel('openai/gpt-5.1')],
      expandedModelId: model.id,
    });

    expect(rows.map((row) => row.kind)).toEqual(['model', 'model', 'route', 'route', 'model']);
    expect(rows.slice(2, 4).map(rightRowKey)).toEqual([
      'route:openai/gpt-5.6:openai/gpt-5.6',
      'route:openai/gpt-5.6:opencode-go/gpt-5.6',
    ]);
  });

  it('appends one notice row while the catalog lane is not ready', () => {
    const pending = buildRightRows({ ...BASE, models: [auto], catalogLane: 'pending' });
    const notices = pending.filter((row) => row.kind === 'notice');

    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind === 'notice' && notices[0].lane).toBe('pending');
    expect(pending[pending.length - 1]).toBe(notices[0]);

    const failed = buildRightRows({ ...BASE, models: [auto], catalogLane: 'failed' });
    const failure = failed.find((row) => row.kind === 'notice');
    expect(failure?.kind === 'notice' && failure.action).toBe('refresh');
  });
});

describe('routeAuthStateFor', () => {
  const variant: ModelVariant = {
    fullId: 'openai/gpt-5.6',
    providerPrefix: 'openai',
    tag: 'openai',
  };

  it('claims nothing when the tool has no credential oracle', () => {
    expect(
      routeAuthStateFor({
        hasOracle: false,
        variant,
        providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'oauth' }] },
      }),
    ).toEqual({ kind: 'unchecked' });
  });

  it('keeps an empty listing distinct from a read one', () => {
    expect(
      routeAuthStateFor({ hasOracle: true, variant, providerAuth: { kind: 'empty' } }),
    ).toEqual({ kind: 'unknown', reason: 'empty' });
  });

  it('names the source when a fact backs the route provider', () => {
    expect(
      routeAuthStateFor({
        hasOracle: true,
        variant,
        providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'oauth' }] },
      }),
    ).toEqual({ kind: 'configured', source: 'oauth' });
  });

  it('needs sign-in when the listing names other providers only', () => {
    expect(
      routeAuthStateFor({
        hasOracle: true,
        variant,
        providerAuth: { kind: 'read', facts: [{ provider: 'Anthropic', source: 'api' }] },
      }),
    ).toEqual({ kind: 'needs-sign-in' });
  });

  it('carries the reason an unreadable listing gave', () => {
    expect(
      routeAuthStateFor({
        hasOracle: true,
        variant,
        providerAuth: { kind: 'unreadable', reason: 'parse-failure' },
      }),
    ).toEqual({ kind: 'unknown', reason: 'parse-failure' });
  });
});
