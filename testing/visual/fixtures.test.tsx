import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, type RenderFeatureResult, tick } from '#testing/helpers/ink.js';
import { App } from '../../src/app/root.js';
import { ACTIVE_OVERLAYS } from '../../src/core/navigation/types.js';
import { findVisualScenario } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { scenarioId } from './contracts/identifiers.js';
import type { FixtureFactory } from './fixtures/common.js';
import { overlayFixtureRegistry } from './fixtures/overlay-fixtures.js';
import {
  createHomeFixture,
  createSetupFixture,
  createSummaryFixture,
  createWorkflowBaseFixture,
  teardownVisualFixture,
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

const OVERLAY_CASES: readonly FixtureCase[] = ACTIVE_OVERLAYS.map((overlay) => {
  const id = `overlay-${overlay}`;
  const factory = overlayFixtureRegistry.get(scenarioId(id));
  if (!factory) throw new Error(`Missing visual fixture for ${id}`);
  return { scenarioId: id, factory };
});

const FIXTURE_CASES = [...SCREEN_CASES, ...OVERLAY_CASES];
const VIEWPORT = viewport({ cols: 80, rows: 24 });
const WORKFLOW_DEPS = createWorkflowFixtureAppDeps();

async function renderFixture(fixtureCase: FixtureCase): Promise<string> {
  const scenario = findVisualScenario(fixtureCase.scenarioId);
  if (!scenario) throw new Error(`Missing visual scenario ${fixtureCase.scenarioId}`);
  const checkpoint = scenario.checkpoints[0];
  if (!checkpoint) throw new Error(`Missing checkpoint for ${fixtureCase.scenarioId}`);

  const lifecycle = fixtureCase.factory();
  let ui: RenderFeatureResult | null = null;
  try {
    await lifecycle.setup({ scenario, checkpoint, viewport: VIEWPORT });
    ui = renderFeature(<App workflowDeps={WORKFLOW_DEPS} />);
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame, fixtureCase.scenarioId).toContain(checkpoint.marker);
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

const ALL_CASE_COUNT = SCREEN_CASES.length + OVERLAY_CASES.length;
