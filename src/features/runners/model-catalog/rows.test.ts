import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import { AUTOMATIC_MODEL } from '../../../core/providers/automatic-model.js';
import type { ModelOption, ModelVariant } from './recency.js';
import { routeDraftOf, stepOptionAxis } from './option-axis.js';
import { mergeOptionFamilies } from './option-merge.js';
import type { RightRow } from './rows.js';
import {
  BROWSE_CATALOG_TEXT,
  buildRightRows,
  rightRowKey,
  routeAuthStateFor,
  sectionOf,
  UNSET_VARIANT_WORD,
} from './rows.js';

const BASE = {
  expandedModelId: null,
  providerAuth: undefined,
  hasOracle: false,
  catalogLane: 'ready',
  persistedModel: undefined,
  customModels: [],
  browseCatalog: false,
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

const OPENAI_VARIANT_PRESETS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

const hybridVariants: ModelVariant[] = [
  { fullId: 'openai/gpt-x-luna', providerPrefix: 'openai', tag: 'openai' },
  { fullId: 'openai/gpt-x-luna-fast', providerPrefix: 'openai', tag: 'openai' },
  { fullId: 'opencode-go/gpt-x-luna', providerPrefix: 'opencode-go', tag: 'opencode-go' },
];

/** The ladder hangs off the route, so a preset given here belongs to `openai` only. */
function hybridModel(variantChoices?: readonly string[]): ModelOption {
  return {
    id: 'openai/gpt-x-luna',
    membership: 'confirmed',
    variants:
      variantChoices === undefined
        ? hybridVariants
        : hybridVariants.map((variant) =>
            variant.providerPrefix === 'openai' ? { ...variant, variantChoices } : variant,
          ),
  };
}

function variantRow(rows: readonly RightRow[]) {
  return rows.find((row) => row.kind === 'axis' && row.axis === 'variant');
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

  it('expands a two-route option family into each route followed by its own axis rows', () => {
    const model = hybridModel();

    const rows = buildRightRows({ ...BASE, models: [model], expandedModelId: model.id });

    expect(rows.map((row) => row.kind)).toEqual(['model', 'route', 'axis', 'route']);
    expect(
      rows.filter((row) => row.kind === 'route').map((row) => row.variant.providerPrefix),
    ).toEqual(['openai', 'opencode-go']);
    // The one-spelling route grows no axis of its own.
    expect(
      rows.filter((row) => row.kind === 'axis').map((row) => [row.providerPrefix, row.axis]),
    ).toEqual([['openai', 'speed']]);
  });

  // The blocker: axis rows locked to the drafted route made every option spelling
  // of every other route unreachable.
  it('reaches every route-and-speed spelling of a two-route, two-speed row', () => {
    const variants: ModelVariant[] = [
      ...hybridVariants,
      { fullId: 'opencode-go/gpt-x-luna-fast', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model: ModelOption = { id: 'openai/gpt-x-luna', membership: 'confirmed', variants };

    const rows = buildRightRows({ ...BASE, models: [model], expandedModelId: model.id });
    const reachable = new Set<string>();
    for (const row of rows) {
      if (row.kind === 'route') {
        reachable.add(routeDraftOf(model, row.variant.providerPrefix, null));
      }
      if (row.kind === 'axis' && row.axis !== 'variant') {
        const from = routeDraftOf(model, row.providerPrefix, null);
        reachable.add(from);
        const stepped = stepOptionAxis(model, row.axis, from, row.providerPrefix);
        if (stepped !== undefined) reachable.add(stepped);
      }
    }

    expect([...reachable].toSorted()).toEqual(variants.map((variant) => variant.fullId).toSorted());
  });

  it('closes each route block with its own last axis row', () => {
    const model = hybridModel(OPENAI_VARIANT_PRESETS);

    const rows = buildRightRows({
      ...BASE,
      models: [model],
      expandedModelId: model.id,
      variantDraft: 'high',
    });

    expect(rows.map((row) => row.kind)).toEqual(['model', 'route', 'axis', 'axis', 'route']);
    const axes = rows.filter((row) => row.kind === 'axis');
    expect(axes.map((row) => [row.axis, row.last])).toEqual([
      ['speed', false],
      ['variant', true],
    ]);
    expect(axes[1]?.value).toBe('high');
  });

  // REQ-022: a route offers its provider's verbatim vocabulary or none at all.
  it('offers no variant preset on a route that spells none', () => {
    const model = hybridModel(OPENAI_VARIANT_PRESETS);

    const rows = buildRightRows({
      ...BASE,
      models: [model],
      expandedModelId: model.id,
      variantDraft: 'minimal',
    });
    const variantRows = rows.filter((row) => row.kind === 'axis' && row.axis === 'variant');

    expect(variantRows.map((row) => row.kind === 'axis' && row.providerPrefix)).toEqual(['openai']);
    // A preset drafted elsewhere is not this route's, so nothing claims it here.
    expect(rows.some((row) => row.kind === 'axis' && row.providerPrefix === 'opencode-go')).toBe(
      false,
    );
  });

  it('reads a drafted preset the drafted route does not spell as unset', () => {
    const model = hybridModel(['high', 'max']);

    const rows = buildRightRows({
      ...BASE,
      models: [model],
      expandedModelId: model.id,
      variantDraft: 'minimal',
    });
    const variantRow = rows.find((row) => row.kind === 'axis' && row.axis === 'variant');

    expect(variantRow?.kind === 'axis' && variantRow.value).toBe(UNSET_VARIANT_WORD);
  });

  it('states whether each ladder can step', () => {
    const model = hybridModel(['high']);

    const rows = buildRightRows({ ...BASE, models: [model], expandedModelId: model.id });
    const axes = rows.filter((row) => row.kind === 'axis');

    // Two speed spellings step; a lone preset still steps between unset and itself.
    expect(axes.map((row) => [row.axis, row.steps])).toEqual([
      ['speed', true],
      ['variant', true],
    ]);
  });

  it('states a sparse grid axis as unable to step from the row it sits on', () => {
    // Nothing makes a catalog list a full grid: `gpt-5-high` has no fast twin, so
    // the speed axis cannot move while the draft sits on it, while effort still can.
    const model: ModelOption = {
      id: 'gpt-5',
      membership: 'confirmed',
      variants: [
        { fullId: 'gpt-5', providerPrefix: '', tag: 'Medium' },
        { fullId: 'gpt-5-fast', providerPrefix: '', tag: 'Medium Fast' },
        { fullId: 'gpt-5-high', providerPrefix: '', tag: 'High' },
      ],
    };

    const rows = buildRightRows({
      ...BASE,
      models: [model],
      expandedModelId: model.id,
      optionDraftId: 'gpt-5-high',
    });

    expect(rows.filter((row) => row.kind === 'axis').map((row) => [row.axis, row.steps])).toEqual([
      ['effort', true],
      ['speed', false],
    ]);
  });

  it('shows an unset variant as unset', () => {
    const model = hybridModel(OPENAI_VARIANT_PRESETS);

    const rows = buildRightRows({
      ...BASE,
      models: [model],
      expandedModelId: model.id,
      variantDraft: null,
    });

    const row = variantRow(rows);
    expect(row?.kind === 'axis' && row.value).toBe(UNSET_VARIANT_WORD);
    expect(OPENAI_VARIANT_PRESETS).not.toContain(UNSET_VARIANT_WORD);
  });

  it('adds no variant row to a model that offers none', () => {
    const model = hybridModel();

    const rows = buildRightRows({
      ...BASE,
      models: [model],
      expandedModelId: model.id,
      variantDraft: 'high',
    });

    expect(variantRow(rows)).toBeUndefined();
  });

  it('keys an axis row by the route it steps inside', () => {
    const model = hybridModel(OPENAI_VARIANT_PRESETS);

    const rows = buildRightRows({ ...BASE, models: [model], expandedModelId: model.id });

    expect(rows.filter((row) => row.kind === 'axis').map(rightRowKey)).toEqual([
      'axis:openai/gpt-x-luna:openai:speed',
      'axis:openai/gpt-x-luna:openai:variant',
    ]);
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

  it.each([
    {
      name: '2 confirmed + 3 catalog',
      input: {
        models: [
          { id: 'openai/gpt-4o', membership: 'confirmed' },
          { id: 'anthropic/claude-3-5-sonnet', membership: 'confirmed' },
          catalogModel('openai/gpt-4o-mini'),
          catalogModel('anthropic/claude-3-5-haiku'),
          catalogModel('google/gemini-2.0-flash'),
        ] satisfies ModelOption[],
      },
      expectedModelCount: 5,
      expectedSections: [],
    },
    {
      name: '0 confirmed + 3 catalog',
      input: {
        models: [
          catalogModel('openai/gpt-4o-mini'),
          catalogModel('anthropic/claude-3-5-haiku'),
          catalogModel('google/gemini-2.0-flash'),
        ],
      },
      expectedModelCount: 3,
      expectedSections: [],
    },
    {
      name: '1 confirmed + 12 catalog',
      input: {
        persistedModel: 'openai/gpt-current',
        models: [
          { id: 'openai/gpt-current', membership: 'confirmed' },
          ...Array.from({ length: 12 }, (_, index) =>
            catalogModel(`anthropic/claude-catalog-${index}`, `2026-01-${String(index + 10)}`),
          ),
        ] satisfies ModelOption[],
      },
      expectedModelCount: 13,
      expectedSections: [],
    },
    {
      name: '2 confirmed + 9 catalog + custom + offline',
      input: {
        persistedModel: 'openai/current',
        customModels: ['mine'],
        models: [
          { id: 'openai/current', membership: 'confirmed' },
          { id: 'openai/detected', membership: 'confirmed' },
          ...Array.from({ length: 9 }, (_, index) =>
            catalogModel(`anthropic/claude-catalog-${index}`, `2026-01-${String(index + 10)}`),
          ),
          { id: 'mine', membership: 'custom', isCustom: true },
          { id: 'xai/offline' },
        ] satisfies ModelOption[],
      },
      expectedModelCount: 13,
      expectedSections: ['Custom'],
    },
  ])('sections $expectedSections for $name', ({ input, expectedModelCount, expectedSections }) => {
    const rows = buildRightRows({ ...BASE, ...input });

    expect(modelRows(rows)).toHaveLength(expectedModelCount);
    expect(sections(rows)).toEqual(expectedSections);
  });

  it('emits no section header when stale rows and catalog rows coexist', () => {
    const stale: ModelOption = { id: 'openai/gpt-4o-prev', membership: 'stale', isStale: true };
    const sugg1 = catalogModel('openai/gpt-4o');
    const sugg2 = catalogModel('anthropic/claude-3-5-sonnet');

    const rows = buildRightRows({
      ...BASE,
      models: [stale, sugg1, sugg2],
    });

    expect(sections(rows)).toEqual([]);
    expect(modelRows(rows).map((row) => row.provenance)).toEqual(['Stale', 'Catalog', 'Catalog']);
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

  it('keeps the authoritative bundled rows while browsing the wider catalog', () => {
    const rows = buildRightRows({
      ...BASE,
      browseCatalog: true,
      models: [alias('opus'), alias('sonnet'), catalogModel('anthropic/claude-opus-5')],
    });

    expect(modelRows(rows).map((row) => row.model.id)).toEqual([
      'opus',
      'sonnet',
      'anthropic/claude-opus-5',
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

  it('keeps the incoming row order instead of re-sorting a long list by release date', () => {
    const ids = [
      'openai/oldest',
      'openai/newest',
      'openai/middle',
      'openai/a',
      'openai/b',
      'openai/c',
      'openai/d',
      'openai/e',
      'openai/f',
      'openai/g',
      'openai/h',
      'openai/i',
      'openai/j',
    ];
    const releaseDates: Record<string, string> = {
      'openai/oldest': '2020-01-01',
      'openai/newest': '2026-12-31',
      'openai/middle': '2023-06-15',
    };
    const models: ModelOption[] = ids.map((id) => ({
      id,
      membership: 'confirmed',
      ...(releaseDates[id] === undefined ? {} : { releaseDate: releaseDates[id] }),
    }));

    const rows = buildRightRows({ ...BASE, models });

    expect(modelRows(rows).map((row) => row.model.id)).toEqual(ids);
  });

  it('offers a browse-catalog escape beside a recovery row', () => {
    const rows = buildRightRows({
      ...BASE,
      persistedModel: 'openai/gone',
      models: [
        { id: 'openai/live', membership: 'confirmed' },
        { id: 'openai/gone', membership: 'stale', isRecovery: true },
      ],
    });

    const last = rows[rows.length - 1];
    expect(last?.kind).toBe('action');
    expect(last?.kind === 'action' && last.action).toBe('browse-catalog');
    expect(last?.kind === 'action' && last.text).toBe(BROWSE_CATALOG_TEXT);
  });

  it('drops the browse-catalog escape once the catalog is being browsed', () => {
    const rows = buildRightRows({
      ...BASE,
      browseCatalog: true,
      persistedModel: 'openai/gone',
      models: [
        { id: 'openai/live', membership: 'confirmed' },
        { id: 'openai/gone', membership: 'stale', isRecovery: true },
      ],
    });

    expect(rows.some((row) => row.kind === 'action')).toBe(false);
  });

  it('offers no browse-catalog escape when every configured model is listed', () => {
    const rows = buildRightRows({
      ...BASE,
      persistedModel: 'openai/live',
      models: [{ id: 'openai/live', membership: 'confirmed' }, catalogModel('anthropic/catalog')],
    });

    expect(rows.some((row) => row.kind === 'action')).toBe(false);
  });

  it('keys the browse-catalog row distinctly', () => {
    const rows = buildRightRows({
      ...BASE,
      models: [{ id: 'openai/gone', membership: 'stale', isRecovery: true }],
    });
    const action = rows.find((row) => row.kind === 'action');

    expect(action).toBeDefined();
    expect(action === undefined ? undefined : rightRowKey(action)).toBe('action:browse-catalog');
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
