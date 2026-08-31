import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import { AUTOMATIC_MODEL } from '../../../core/providers/automatic-model.js';
import type { ModelOption, ModelVariant } from './recency.js';
import { mergeOptionFamilies } from './option-axis.js';
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

function axisValues(rows: readonly RightRow[]): string[] {
  return rows.filter((row) => row.kind === 'axis').map((row) => row.value);
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

  it('pins the automatic row above a long unsectioned list', () => {
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
    expect(sections(rows)).toEqual([]);
  });

  it('keeps every kilo-shaped row in one unsectioned list', () => {
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

    expect(models).toHaveLength(126);
    expect(seen).toEqual([]);

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
    expect(rows.some((row) => row.kind === 'axis')).toBe(false);
  });

  it('expands a luna-shaped option family into axis rows, not routes', () => {
    const luna = mergeOptionFamilies(
      cursorModelOptions().filter((row) => row.id.startsWith('gpt-5.6-luna')),
    )[0];
    if (luna === undefined) throw new Error('expected luna family');

    const rows = buildRightRows({
      ...BASE,
      models: [luna],
      expandedModelId: luna.id,
    });

    expect(rows.map((row) => row.kind)).toEqual(['model', 'axis', 'axis']);
    expect(rows.filter((row) => row.kind === 'route')).toHaveLength(0);
    expect(
      rows.filter((row) => row.kind === 'axis').map((row) => row.kind === 'axis' && row.axis),
    ).toEqual(['effort', 'speed']);
    expect(
      rows.filter((row) => row.kind === 'axis').map((row) => row.kind === 'axis' && row.last),
    ).toEqual([false, true]);

    // The value column is the only place a cycled draft becomes visible, so it
    // follows the draft rather than the family's own id.
    expect(axisValues(rows)).toEqual(['High', 'Standard']);
    const cycled = buildRightRows({
      ...BASE,
      models: [luna],
      expandedModelId: luna.id,
      optionDraftId: 'gpt-5.6-luna-max-fast',
    });
    expect(axisValues(cycled)).toEqual(['Max', 'Fast']);
  });

  it('expands a grok option family into axis rows, not routes', () => {
    const grok = mergeOptionFamilies(
      cursorModelOptions().filter((row) => row.id.startsWith('cursor-grok-4.6')),
    )[0];
    if (grok === undefined) throw new Error('expected grok family');

    const rows = buildRightRows({
      ...BASE,
      models: [grok],
      expandedModelId: grok.id,
    });

    expect(rows.map((row) => row.kind)).toEqual(['model', 'axis', 'axis']);
    expect(rows.filter((row) => row.kind === 'route')).toHaveLength(0);
    expect(
      rows.filter((row) => row.kind === 'axis').map((row) => row.kind === 'axis' && row.axis),
    ).toEqual(['effort', 'speed']);
  });

  it('appends one notice row while the catalog lane is not ready', () => {
    const pending = buildRightRows({ ...BASE, models: [auto], catalogLane: 'pending' });
    const notices = pending.filter((row) => row.kind === 'notice');

    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind === 'notice' && notices[0].lane).toBe('pending');
    expect(notices[0]?.kind === 'notice' && notices[0].text).toBe('Loading models…');
    expect(pending[pending.length - 1]).toBe(notices[0]);

    const failed = buildRightRows({ ...BASE, models: [auto], catalogLane: 'failed' });
    const failure = failed.find((row) => row.kind === 'notice');
    expect(failure?.kind === 'notice' && failure.action).toBe('refresh');
    expect(failure?.kind === 'notice' && failure.text).toBe('Could not load models');
  });

  it('renders rows for [2 confirmed, 3 suggestions] with a single suggestions section boundary before row 3', () => {
    const confirmed1: ModelOption = { id: 'openai/gpt-4o', membership: 'confirmed' };
    const confirmed2: ModelOption = { id: 'anthropic/claude-3-5-sonnet', membership: 'confirmed' };
    const sugg1 = catalogModel('openai/gpt-4o-mini');
    const sugg2 = catalogModel('anthropic/claude-3-5-haiku');
    const sugg3 = catalogModel('google/gemini-2.0-flash');

    const rows = buildRightRows({
      ...BASE,
      models: [confirmed1, confirmed2, sugg1, sugg2, sugg3],
    });

    const placed = modelRows(rows);
    expect(placed).toHaveLength(5);
    expect(sections(rows)).toEqual(['suggestions']);
    expect(rows[0]?.kind === 'model' ? sectionOf(rows[0]) : null).toBeUndefined();
    expect(rows[1]?.kind === 'model' ? sectionOf(rows[1]) : null).toBeUndefined();
    expect(rows[2]?.kind === 'model' ? sectionOf(rows[2]) : null).toBe('suggestions');
    expect(rows[3]?.kind === 'model' ? sectionOf(rows[3]) : null).toBe('suggestions');
    expect(rows[4]?.kind === 'model' ? sectionOf(rows[4]) : null).toBe('suggestions');
  });

  it('renders rows for [0 confirmed, 3 suggestions] with no suggestions header', () => {
    const sugg1 = catalogModel('openai/gpt-4o-mini');
    const sugg2 = catalogModel('anthropic/claude-3-5-haiku');
    const sugg3 = catalogModel('google/gemini-2.0-flash');

    const rows = buildRightRows({
      ...BASE,
      models: [sugg1, sugg2, sugg3],
    });

    const placed = modelRows(rows);
    expect(placed).toHaveLength(3);
    expect(sections(rows)).toEqual([]);
    for (const row of rows) {
      expect(sectionOf(row)).toBeUndefined();
    }
  });

  it('emits suggestions header when stale rows and catalog suggestions coexist', () => {
    const stale: ModelOption = { id: 'openai/gpt-4o-prev', membership: 'stale', isStale: true };
    const sugg1 = catalogModel('openai/gpt-4o');
    const sugg2 = catalogModel('anthropic/claude-3-5-sonnet');

    const rows = buildRightRows({
      ...BASE,
      models: [stale, sugg1, sugg2],
    });

    expect(sections(rows)).toEqual(['suggestions']);
    expect(rows[0]?.kind === 'model' ? sectionOf(rows[0]) : null).toBeUndefined();
    expect(rows[1]?.kind === 'model' ? sectionOf(rows[1]) : null).toBe('suggestions');
  });

  it('custom section is absent with no custom rows', () => {
    const persisted = 'openai/gpt-current';
    const catalog = Array.from({ length: 12 }, (_, index) =>
      catalogModel(`anthropic/claude-catalog-${index}`, `2026-01-${String(index + 10)}`),
    );
    const rows = buildRightRows({
      ...BASE,
      persistedModel: persisted,
      models: [{ id: persisted, membership: 'confirmed' }, ...catalog],
    });

    expect(sections(rows)).toEqual(['suggestions']);
    expect(sections(rows)).not.toContain('Custom');
  });

  it('sections both suggestions and Custom when custom rows exist in a long list', () => {
    const persisted = 'openai/current';
    const catalog = Array.from({ length: 9 }, (_, index) =>
      catalogModel(`anthropic/claude-catalog-${index}`, `2026-01-${String(index + 10)}`),
    );
    const rows = buildRightRows({
      ...BASE,
      persistedModel: persisted,
      customModels: ['mine'],
      models: [
        { id: persisted, membership: 'confirmed' },
        { id: 'openai/detected', membership: 'confirmed' },
        ...catalog,
        { id: 'mine', membership: 'custom', isCustom: true },
        { id: 'xai/offline' },
      ],
    });

    expect(sections(rows)).toEqual(['suggestions', 'Custom']);
  });

  it('bundled rows hidden when a live lane exists', () => {
    const rows = buildRightRows({
      ...BASE,
      models: [
        { id: 'openai/live', membership: 'confirmed' },
        catalogModel('anthropic/catalog'),
        alias('Opus'),
        alias('Sonnet'),
      ],
    });

    expect(modelRows(rows).map((row) => row.model.id)).toEqual([
      'openai/live',
      'anthropic/catalog',
    ]);
  });

  it('persisted bundled row survives the filter', () => {
    const persisted = 'Opus';
    const rows = buildRightRows({
      ...BASE,
      persistedModel: persisted,
      models: [alias('Opus'), alias('Sonnet'), catalogModel('anthropic/catalog')],
    });
    const ids = modelRows(rows).map((row) => row.model.id);

    expect(ids).toContain(persisted);
    expect(ids).not.toContain('Sonnet');
    expect(ids).toContain('anthropic/catalog');
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
