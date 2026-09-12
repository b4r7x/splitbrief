import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_OVERLAYS, ALL_SCREENS } from '../../src/core/navigation/types.js';
import { configStore } from '../../src/stores/project/config.js';
import { routerStore } from '../../src/stores/navigation/router.js';
import {
  listVisualScenarios,
  REQUIRED_VIEWPORTS,
  REQUIRED_WORKFLOW_CHECKPOINT_IDS,
  REQUIRED_WORKFLOW_CHECKPOINT_KINDS,
  VISUAL_CATALOG,
  VISUAL_CATALOG_VERSION,
  VISUAL_FIXTURE_VERSION,
} from './catalog.js';
import { formatViewport } from './contracts/geometry.js';
import { overlayFixtureRegistry } from './fixtures/overlay-fixtures.js';
import { screenFixtureRegistry } from './fixtures/screen-fixtures.js';
import { workflowFixtureRegistry } from './fixtures/workflow/registry.js';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Scenarios whose surface cannot mount at the default matrix and say so in the catalog. */
const SCENARIO_VIEWPORT_EXCEPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['home-cold-detecting', ['80x40']],
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visual catalog', () => {
  it('covers the exact router screen and overlay unions with unique versioned scenarios', () => {
    const screens = VISUAL_CATALOG.flatMap((scenario) =>
      scenario.surface.kind === 'screen' ? [scenario.surface.screen] : [],
    );
    const overlays = VISUAL_CATALOG.flatMap((scenario) =>
      scenario.surface.kind === 'overlay' ? [scenario.surface.overlay] : [],
    );
    const scenarioIds = VISUAL_CATALOG.map((scenario) => scenario.id);
    const duplicateIds = scenarioIds.filter((id, index) => scenarioIds.indexOf(id) !== index);

    expect(sorted(new Set(screens))).toEqual(sorted(ALL_SCREENS));
    expect(sorted(new Set(overlays))).toEqual(sorted(ACTIVE_OVERLAYS));
    expect(duplicateIds).toEqual([]);
    expect(VISUAL_CATALOG_VERSION).toBe(1);
    expect(
      VISUAL_CATALOG.every(
        (scenario) =>
          scenario.fixtureVersion === VISUAL_FIXTURE_VERSION &&
          scenario.title.length > 0 &&
          scenario.checkpoints.length > 0,
      ),
    ).toBe(true);
  });

  it('contains the required viewport matrix, workflow checkpoints, and named crops', () => {
    const checkpointIds = new Set<string>(
      VISUAL_CATALOG.flatMap((scenario) => scenario.checkpoints.map((checkpoint) => checkpoint.id)),
    );
    const checkpointKinds = new Set(
      VISUAL_CATALOG.flatMap((scenario) =>
        scenario.checkpoints.map((checkpoint) => checkpoint.kind),
      ),
    );

    expect(REQUIRED_VIEWPORTS.map(formatViewport)).toEqual(['120x40', '80x24', '60x18']);
    expect(REQUIRED_WORKFLOW_CHECKPOINT_IDS.every((id) => checkpointIds.has(id))).toBe(true);
    expect(REQUIRED_WORKFLOW_CHECKPOINT_KINDS.every((kind) => checkpointKinds.has(kind))).toBe(
      true,
    );
    expect(VISUAL_CATALOG.every((scenario) => scenario.elements.length > 0)).toBe(true);
  });

  it('keeps every scenario on the required viewport matrix except where the catalog says so', () => {
    for (const scenario of VISUAL_CATALOG) {
      expect(scenario.viewports.map(formatViewport)).toEqual(
        SCENARIO_VIEWPORT_EXCEPTIONS.get(scenario.id) ?? REQUIRED_VIEWPORTS.map(formatViewport),
      );
    }
  });

  it('pairs every scenario with a fixture and leaves no fixture unreferenced', () => {
    const registered = [
      ...workflowFixtureRegistry.keys(),
      ...screenFixtureRegistry.keys(),
      ...overlayFixtureRegistry.keys(),
    ];

    expect(new Set(registered).size).toBe(registered.length);
    expect(sorted(registered)).toEqual(sorted(VISUAL_CATALOG.map((scenario) => scenario.id)));
  });

  it('gives each screen and overlay scenario its own fixture registration', () => {
    const factories = [...screenFixtureRegistry.values(), ...overlayFixtureRegistry.values()];

    expect(new Set(factories).size).toBe(factories.length);
  });

  it('lists the catalog without changing stores or starting network work', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const routeBefore = routerStore.get();
    const configBefore = configStore.get();

    const scenarios = listVisualScenarios();
    expect(scenarios).toEqual(VISUAL_CATALOG);
    expect(routerStore.get()).toBe(routeBefore);
    expect(configStore.get()).toBe(configBefore);
    expect(fetch).not.toHaveBeenCalled();
  });
});
