import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, type RenderFeatureResult, tick } from '#testing/helpers/ink.js';
import { App } from '../../src/app/root.js';
import { ACTIVE_OVERLAYS } from '../../src/core/navigation/types.js';
import { ConfigSchema } from '../../src/core/schemas/config.js';
import { detectionStore } from '../../src/stores/project/detection.js';
import { findVisualScenario } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { scenarioId } from './contracts/identifiers.js';
import type { FixtureContext, FixtureFactory } from './fixtures/common.js';
import { overlayFixtureRegistry } from './fixtures/overlay-fixtures.js';
import {
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
  const factory = overlayFixtureRegistry.get(scenarioId(id));
  if (!factory) throw new Error(`Missing visual fixture for ${id}`);
  return { scenarioId: id, factory };
});

const FIXTURE_CASES = [...SCREEN_CASES, ...OVERLAY_CASES];
const VIEWPORT = viewport({ cols: 80, rows: 24 });
const WORKFLOW_DEPS = createWorkflowFixtureAppDeps();

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
