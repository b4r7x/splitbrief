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
  createSummaryFixture,
  createWorkflowBaseFixture,
  teardownVisualFixture,
  visualConfig,
} from './fixtures/screen-fixtures.js';
import { createWorkflowFixtureAppDeps } from './fixtures/workflow/setup.js';

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
  { scenarioId: 'summary-success', factory: createSummaryFixture },
  { scenarioId: 'setup-initial', factory: createSetupFixture },
];

// The reviewer picker opens on the inherit row, so its scenario is named for that state.
const OVERLAY_SCENARIO_IDS: Partial<Record<(typeof ACTIVE_OVERLAYS)[number], string>> = {
  'reviewer-picker': 'overlay-reviewer-picker-inherited',
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
  const context = fixtureContext(fixtureCase.scenarioId);
  const lifecycle = fixtureCase.factory();
  let ui: RenderFeatureResult | null = null;
  try {
    await lifecycle.setup(context);
    ui = renderFeature(<App workflowDeps={WORKFLOW_DEPS} />);
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame, fixtureCase.scenarioId).toContain(context.checkpoint.marker);
    return frame;
  } finally {
    ui?.unmount();
    await lifecycle.teardown();
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

  it('turns the pinned option into exactly one catalog row with no context length', async () => {
    const lifecycle = requireOverlayFixture('overlay-planner-picker')();
    try {
      await lifecycle.setup(fixtureContext('overlay-planner-picker'));

      const rows = resolveModelCatalog('claude-code', { cache: modelCacheStore }).filter(
        (entry) => entry.id === 'claude-fable-5-1[1m]',
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe('Fable');
      expect(rows[0]?.contextLength).toBeUndefined();
    } finally {
      await lifecycle.teardown();
    }
  });

  it('carries the Claude 5 rows and exactly five opencode effort ladders in the models.dev slice', () => {
    const anthropic = MODELS_DEV_SLICE.anthropic?.models ?? {};
    const claudeFive: Record<string, string> = {
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

    const opencode = Object.entries(MODELS_DEV_SLICE.opencode?.models ?? {});
    expect(opencode).toHaveLength(31);
    // Rungs, not just which rows carry a ladder: no captured frame draws them, and
    // `effort-vocabulary-source` replaces the hand-written table with exactly these arrays.
    const ladders: Record<string, unknown> = {};
    for (const [id, model] of opencode) {
      if (model.reasoning_options === undefined) continue;
      ladders[id] = model.reasoning_options.find((option) => option.type === 'effort')?.values;
    }
    expect(ladders).toStrictEqual({
      'openai/gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'opencode-go/gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'openai/gpt-5.1': ['none', 'low', 'medium', 'high'],
      'openai/gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
      'openai/o3': ['low', 'medium', 'high'],
    });
    // A model that publishes no ladder has to stay in the fixture: the axis rows
    // are proved by a row that draws none as much as by one that draws six.
    expect(
      opencode.filter(([, model]) => model.reasoning_options === undefined).length,
    ).toBeGreaterThan(0);
  });

  it('covers every Copilot model the tool serves in the models.dev slice', () => {
    // The enum `copilot help config` prints, read back from the recorded output itself
    // (`testing/fixtures/copilot/help-config.txt`, GitHub Copilot CLI 1.0.77), so a recapture of
    // the tool moves this contract with it instead of leaving a copy behind. The rows transcribe
    // models.dev's `github-copilot` provider: 33 models covering 24 of these 25 ids, with
    // `claude-opus-4.8-fast` the fixture's one "served by the tool, unknown to the catalog" row.
    // That provider has since dropped `claude-sonnet-4.5`, `claude-opus-4.6`, `claude-opus-4.5`
    // and `gemini-3.1-pro-preview`, so regenerating the block from a live fetch widens that hole
    // from one id to five. Those four keep the dates `github-copilot` itself published, which for
    // `claude-opus-4.6` is 2026-02-05 — the value 14 other models.dev providers carry — and not
    // `anthropic`'s 2026-02-04 for the same model.
    // `modalities` is the one field the fixture's other 66 rows carry and these 24 do not, so a
    // Copilot model resolved from here reports no `supportsImages` (`modelToDetected`). That is
    // inert: `seatSupportsImages` returns `true` for every `cli` runner before it reads the fact,
    // and `detectedModelFact` yields nothing off a non-`api` seat.
    const served = readFileSync(
      join(import.meta.dirname, '../fixtures/copilot/help-config.txt'),
      'utf8',
    ).match(/(?<=^ *- ")[^"]+(?="$)/gm);
    if (served === null) throw new Error('copilot help-config fixture listed no models');
    const copilot = MODELS_DEV_SLICE['github-copilot']?.models ?? {};

    expect(served.filter((id) => copilot[id] === undefined)).toEqual(['claude-opus-4.8-fast']);
    expect(Object.keys(copilot).filter((id) => !served.includes(id))).toEqual([]);

    // Rungs, not row counts: the ladders are transcribed per model, so an approximated
    // block passes membership and fails here.
    const effort = (id: string): readonly string[] | undefined =>
      copilot[id]?.reasoning_options?.find((option) => option.type === 'effort')?.values;
    expect(effort('gpt-5.5')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(effort('gpt-5.6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(copilot['kimi-k2.7-code']?.reasoning_options).toEqual([]);

    // `release_date` orders the browse lane (`compareSuggestions`, `sortModelsByRecency`), so a row
    // without one is ordered by the id heuristic instead of by recency.
    const undated = Object.keys(copilot).filter((id) => copilot[id]?.release_date === undefined);
    expect(undated).toEqual([]);
  });

  it('resolves the seeded slice into the duplicated Claude alias rows the picker draws', async () => {
    const lifecycle = requireOverlayFixture('overlay-planner-picker-no-listing')();
    try {
      await lifecycle.setup(fixtureContext('overlay-planner-picker-no-listing'));

      const entries = resolveModelCatalog('claude-code', { cache: modelCacheStore });
      const census = (name: string): number =>
        entries.filter((entry) => entry.displayName === name).length;

      expect(census('Claude Opus 5')).toBe(4);
      expect(census('Claude Sonnet 5')).toBe(3);
      expect(census('Claude Fable 5')).toBe(1);
      expect(census('Claude Haiku 4.5 (latest)')).toBe(1);

      const pinned = entries.filter((entry) => entry.id === 'claude-fable-5-1[1m]');
      expect(pinned).toHaveLength(1);
      expect(pinned[0]?.displayName).toBe('Fable');
      expect(pinned[0]?.contextLength).toBeUndefined();
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
  workflow: {
    mode: 'standard',
    persistTranscript: false,
    maxRetries: 2,
  },
});

const ALL_CASE_COUNT = SCREEN_CASES.length + OVERLAY_CASES.length;
