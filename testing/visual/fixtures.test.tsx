import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, type RenderFeatureResult, tick } from '#testing/helpers/ink.js';
import { App } from '../../src/app/root.js';
import { ACTIVE_OVERLAYS } from '../../src/core/navigation/types.js';
import { ConfigSchema } from '../../src/core/schemas/config.js';
import { ModelsDevCatalogSchema } from '../../src/core/schemas/models-dev.js';
import { resolveModelCatalog } from '../../src/engine/providers/model/catalog.js';
import { modelCacheStore } from '../../src/stores/discovery/model-cache/state.js';
import { detectionStore } from '../../src/stores/project/detection.js';
import { findVisualScenario } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { scenarioId } from './contracts/identifiers.js';
import type { FixtureContext, FixtureFactory } from './fixtures/common.js';
import { overlayFixtureRegistry } from './fixtures/overlay-fixtures.js';
import {
  CLAUDE_CODE_OPTION_CACHE,
  createHomeFixture,
  createSetupFixture,
  createWorkflowBaseFixture,
  teardownVisualFixture,
  visualConfig,
} from './fixtures/screen-fixtures.js';
import { createWorkflowFixtureAppDeps } from './fixtures/workflow/setup.js';
import { enterCaptureEnvironment } from './gallery/environment.js';

interface FixtureCase {
  readonly scenarioId: string;
  readonly factory: FixtureFactory;
}

function requireOverlayFixture(id: string): FixtureFactory {
  const factory = overlayFixtureRegistry.get(scenarioId(id));
  if (!factory) throw new Error(`Missing visual fixture for ${id}`);
  return factory;
}

const SCREEN_CASES: readonly FixtureCase[] = [
  { scenarioId: 'home-empty', factory: createHomeFixture },
  { scenarioId: 'workflow-idle', factory: createWorkflowBaseFixture },
  { scenarioId: 'setup-initial', factory: createSetupFixture },
];

// The reviewer picker opens on the inherit row, so its scenario is named for that state, and the
// stop sheet is named for the run it stops rather than for the overlay it rides in.
const OVERLAY_SCENARIO_IDS: Partial<Record<(typeof ACTIVE_OVERLAYS)[number], string>> = {
  'reviewer-picker': 'overlay-reviewer-picker-inherited',
  'stop-sheet': 'workflow-stop-sheet',
};

const OVERLAY_CASES: readonly FixtureCase[] = ACTIVE_OVERLAYS.map((overlay) => {
  const id = OVERLAY_SCENARIO_IDS[overlay] ?? `overlay-${overlay}`;
  return { scenarioId: id, factory: requireOverlayFixture(id) };
});

const FIXTURE_CASES = [...SCREEN_CASES, ...OVERLAY_CASES];
const VIEWPORT = viewport({ cols: 80, rows: 24 });
const WORKFLOW_DEPS = createWorkflowFixtureAppDeps();
const MODELS_DEV_SLICE = ModelsDevCatalogSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/models-dev-slice.json'), 'utf8')),
);

function fixtureContext(id: string): FixtureContext {
  const scenario = findVisualScenario(id);
  if (!scenario) throw new Error(`Missing visual scenario ${id}`);
  const checkpoint = scenario.checkpoints[0];
  if (!checkpoint) throw new Error(`Missing checkpoint for ${id}`);
  return { scenario, checkpoint, viewport: VIEWPORT };
}

async function renderFixture(fixtureCase: FixtureCase): Promise<string> {
  const environment = enterCaptureEnvironment({ viewport: VIEWPORT });
  const context = fixtureContext(fixtureCase.scenarioId);
  const lifecycle = fixtureCase.factory();
  let ui: RenderFeatureResult | null = null;
  try {
    await lifecycle.setup(context);
    ui = renderFeature(<App workflowDeps={WORKFLOW_DEPS} />, context.viewport);
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame, fixtureCase.scenarioId).toContain(context.checkpoint.marker);
    return frame;
  } finally {
    ui?.unmount();
    await lifecycle.teardown();
    environment.restore();
  }
}

async function renderFixtures(cases: readonly FixtureCase[]): Promise<ReadonlyMap<string, string>> {
  const frames = new Map<string, string>();
  for (const fixtureCase of cases) {
    frames.set(fixtureCase.scenarioId, await renderFixture(fixtureCase));
  }
  return frames;
}

describe('visual screen and overlay fixtures', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  afterEach(() => {
    teardownVisualFixture();
  });

  it('renders every screen and overlay fixture through the production App at 80x24', async () => {
    const frames = await renderFixtures(FIXTURE_CASES);

    expect(frames.size).toBe(ALL_CASE_COUNT);
    expect([...frames.values()].every((frame) => frame.length > 0)).toBe(true);
  });

  it('produces the same complete frames when fixtures run in reverse order', async () => {
    const forward = await renderFixtures(FIXTURE_CASES);
    const reverse = await renderFixtures([...FIXTURE_CASES].reverse());

    for (const fixtureCase of FIXTURE_CASES) {
      expect(reverse.get(fixtureCase.scenarioId), fixtureCase.scenarioId).toBe(
        forward.get(fixtureCase.scenarioId),
      );
    }
  });
});

describe('visual fixture seeds', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  afterEach(() => {
    teardownVisualFixture();
  });

  it('applies a config override without disturbing the rest of the visual config', () => {
    const base = visualConfig();
    const withReviewer = visualConfig({
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
    });

    expect(base).toEqual(CONFIG_BEFORE_THE_OVERRIDE_PARAMETER);
    expect(base.reviewer).toBeUndefined();
    expect(withReviewer.reviewer).toBeDefined();
    expect(ConfigSchema.parse(withReviewer)).toEqual(withReviewer);
    expect({ ...withReviewer, reviewer: undefined }).toEqual({ ...base, reviewer: undefined });
  });

  it('seeds an unfetched readiness state only for the cold home fixture', async () => {
    const context = fixtureContext('home-empty');

    const cold = createHomeFixture({ cold: true });
    await cold.setup(context);
    expect(detectionStore.get().refresh.readiness.fetchedAt).toBeNull();
    await cold.teardown();

    const warm = createHomeFixture();
    await warm.setup(context);
    expect(detectionStore.get().refresh.readiness.fetchedAt).not.toBeNull();
    await warm.teardown();
  });

  it('pins the Claude Code option cache for every fixture and releases it on teardown', async () => {
    for (const fixtureCase of FIXTURE_CASES) {
      const lifecycle = fixtureCase.factory();
      try {
        await lifecycle.setup(fixtureContext(fixtureCase.scenarioId));

        const pinned = modelCacheStore.getClaudeCodeModelOptions();
        expect(pinned, fixtureCase.scenarioId).toHaveLength(1);
        expect(pinned[0]?.id, fixtureCase.scenarioId).toBe('claude-fable-5-1[1m]');
        expect(pinned[0]?.displayName, fixtureCase.scenarioId).toBe('Fable');
        // The sentence Claude stores beside the label — it opens by repeating the display name,
        // which is exactly the shape the catalog peels before a row spends its name column on it.
        expect(pinned[0]?.description, fixtureCase.scenarioId).toContain(
          'Fable 5.1 · Most capable',
        );
        // A machine whose own `~/.claude.json` holds that entry passes the field
        // assertions unpinned; the harness's own constant is the one value no
        // account cache can hand back, on any machine.
        expect(pinned, fixtureCase.scenarioId).toBe(CLAUDE_CODE_OPTION_CACHE);
      } finally {
        await lifecycle.teardown();
      }
      expect(modelCacheStore.getClaudeCodeModelOptions(), fixtureCase.scenarioId).not.toBe(
        CLAUDE_CODE_OPTION_CACHE,
      );
    }
  });

  // The pinned option spells `fable[1m]` the way Claude's own cache spells it, so it folds into
  // that alias row. This fixture seeds no models.dev catalog, which is the cold start every
  // session opens on: the row still paints a window, the one Claude bakes for `claude-fable-5-1`.
  it('folds the pinned option into its alias row and keeps that row its window', async () => {
    const lifecycle = requireOverlayFixture('overlay-planner-picker')();
    try {
      await lifecycle.setup(fixtureContext('overlay-planner-picker'));

      const entries = resolveModelCatalog('claude-code', { cache: modelCacheStore });
      const rows = entries.filter((entry) => entry.selectionId === 'fable[1m]');

      expect(entries.filter((entry) => entry.id === 'claude-fable-5-1[1m]')).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe('Fable 5.1 (1M)');
      // The alias wrote the one fact that tells it from plain `fable`, so the account's sentence
      // does not evict it — the row reads like its two `[1m]` siblings.
      expect(rows[0]?.detail).toBe('forces the 1M window');
      expect(rows[0]?.contextLength).toBe(1_000_000);
    } finally {
      await lifecycle.teardown();
    }
  });

  it('carries the Claude 5 rows in the models.dev slice', () => {
    const anthropic = MODELS_DEV_SLICE.anthropic?.models ?? {};
    const claudeFive: Record<string, string> = {
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-opus-5': 'Claude Opus 5',
      'claude-sonnet-5': 'Claude Sonnet 5',
      'claude-fable-5-1': 'Claude Fable 5.1',
      'claude-fable-5': 'Claude Fable 5',
    };
    for (const [id, name] of Object.entries(claudeFive)) {
      expect(anthropic[id]?.name, id).toBe(name);
      expect(anthropic[id]?.limit?.context, id).toBe(1_000_000);
      // `claude-code`'s own flag ladder holds these same five rungs and stands in for a
      // row that publishes none, so a deleted ladder is invisible everywhere but here.
      expect(
        anthropic[id]?.reasoning_options?.find((option) => option.type === 'effort')?.values,
        id,
      ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    }
    expect(
      anthropic['claude-sonnet-5']?.reasoning_options?.some((option) => option.type === 'toggle'),
    ).toBe(true);

    const haiku = anthropic['claude-haiku-4-5'];
    expect(haiku?.name).toBe('Claude Haiku 4.5 (latest)');
    expect(haiku?.limit?.context).toBe(200_000);
    expect(haiku?.reasoning_options?.map((option) => option.type)).toEqual(['budget_tokens']);
  });

  it('resolves the seeded slice into one distinctly labelled row per Claude alias', async () => {
    const lifecycle = requireOverlayFixture('overlay-planner-picker-no-listing')();
    try {
      await lifecycle.setup(fixtureContext('overlay-planner-picker-no-listing'));

      const entries = resolveModelCatalog('claude-code', { cache: modelCacheStore });

      // The slice answers all four models the nine aliases resolve to, so every row carries a
      // window and no two share a label — the defect the screenshot showed was four rows reading
      // `Claude Opus 5` beside a bare `Fable` with an empty size column.
      expect(entries).toHaveLength(9);
      expect(new Set(entries.map((entry) => entry.displayName)).size).toBe(9);
      expect(entries.filter((entry) => entry.contextLength === undefined)).toEqual([]);

      expect(entries.filter((entry) => entry.id === 'claude-fable-5-1[1m]')).toEqual([]);
      const pinned = entries.find((entry) => entry.selectionId === 'fable[1m]');
      expect(pinned?.detail).toBe('forces the 1M window');
      expect(pinned?.contextLength).toBe(1_000_000);
    } finally {
      await lifecycle.teardown();
    }
  });
});

// The literal `visualConfig` built before it took overrides: the default call
// must still produce exactly this config, or every re-baselined frame moves.
const CONFIG_BEFORE_THE_OVERRIDE_PARAMETER = makeConfig({
  planner: {
    kind: 'cli',
    tool: 'claude-code',
    model: 'claude-sonnet-4',
  },
  implementer: {
    kind: 'api',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    apiBase: 'http://127.0.0.1:11434/v1',
    contextLength: 32_768,
    temperature: 0.2,
  },
});

const ALL_CASE_COUNT = SCREEN_CASES.length + OVERLAY_CASES.length;
