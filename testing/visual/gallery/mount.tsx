import { App } from '../../../src/app/root.js';
import type { AppProps } from '../../../src/app/root.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import * as React from 'react';
import {
  CheckpointDefinitionSchema,
  ScenarioDefinitionSchema,
  type CheckpointDefinition,
  type ScenarioDefinition,
} from '../contracts/catalog.js';
import { ViewportSchema, type Viewport } from '../contracts/geometry.js';
import type { CheckpointPredicate, FixtureFactory, FixtureLifecycle } from '../fixtures/common.js';
import { overlayFixtureRegistry } from '../fixtures/overlay-fixtures.js';
import { screenFixtureRegistry } from '../fixtures/screen-fixtures.js';
import { createWorkflowFixtureAppDeps } from '../fixtures/workflow/setup.js';
import { workflowFixtureProjections } from '../fixtures/workflow/projections.js';
import { workflowFixtureRegistry } from '../fixtures/workflow/registry.js';
import {
  flushEffects,
  renderFeature,
  type RenderFeatureResult,
  type RenderViewport,
} from '../../helpers/ink.js';
import { enterCaptureEnvironment } from './environment.js';
import { waitForCheckpoint } from './checkpoints.js';

export interface MountGalleryScenarioOptions {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
}

export interface GalleryCheckpointWaitOptions {
  readonly predicate?: CheckpointPredicate | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface GalleryCaptureHandle {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
  readonly stdin: RenderFeatureResult['stdin'];
  readonly lastFrame: () => string | undefined;
  readonly frameHistory: () => readonly string[];
  readonly waitForCheckpoint: (options?: GalleryCheckpointWaitOptions) => Promise<string>;
  readonly unmount: () => Promise<void>;
}

export async function mountGalleryScenario(
  options: MountGalleryScenarioOptions,
): Promise<GalleryCaptureHandle> {
  const scenario = ScenarioDefinitionSchema.parse(options.scenario);
  const requestedCheckpoint = CheckpointDefinitionSchema.parse(options.checkpoint);
  const checkpoint = resolveCheckpoint(scenario, requestedCheckpoint);
  const viewport = ViewportSchema.parse(options.viewport);
  assertSupportedViewport(scenario, viewport);

  const fixture = resolveFixtureFactory(scenario)();
  const environment = enterCaptureEnvironment({ viewport });
  const rendered = await setupAndRender({
    scenario,
    checkpoint,
    viewport,
    fixture,
    restoreEnvironment: environment.restore,
  });

  let unmountPromise: Promise<void> | undefined;
  const unmount = (): Promise<void> => {
    if (unmountPromise !== undefined) return unmountPromise;
    unmountPromise = unmountCapture({ rendered, fixture, restoreEnvironment: environment.restore });
    return unmountPromise;
  };

  return {
    scenario,
    checkpoint,
    viewport,
    stdin: rendered.stdin,
    lastFrame: rendered.lastFrame,
    frameHistory: () => [...rendered.frames],
    waitForCheckpoint: async (waitOptions = {}) => {
      try {
        return await waitForCheckpoint({
          scenario,
          checkpoint,
          viewport,
          lastFrame: rendered.lastFrame,
          predicate: waitOptions.predicate,
          timeoutMs: waitOptions.timeoutMs,
        });
      } catch (error) {
        return unmountAfterFailure(unmount, error);
      }
    },
    unmount,
  };
}

function resolveFixtureFactory(scenario: ScenarioDefinition): FixtureFactory {
  const factory =
    workflowFixtureRegistry.get(scenario.id) ??
    screenFixtureRegistry.get(scenario.id) ??
    overlayFixtureRegistry.get(scenario.id);
  if (factory === undefined) throw new Error(`No visual fixture registered for ${scenario.id}`);
  return factory;
}

function resolveCheckpoint(
  scenario: ScenarioDefinition,
  requested: CheckpointDefinition,
): CheckpointDefinition {
  const checkpoint = scenario.checkpoints.find((candidate) => candidate.id === requested.id);
  if (
    checkpoint === undefined ||
    checkpoint.kind !== requested.kind ||
    checkpoint.marker !== requested.marker ||
    checkpoint.timeoutMs !== requested.timeoutMs
  ) {
    throw new Error(`Checkpoint ${requested.id} does not belong to scenario ${scenario.id}`);
  }
  return checkpoint;
}

function assertSupportedViewport(scenario: ScenarioDefinition, viewport: Viewport): void {
  const isSupported = scenario.viewports.some(
    (candidate) => candidate.cols === viewport.cols && candidate.rows === viewport.rows,
  );
  if (!isSupported) {
    throw new Error(
      `Viewport ${viewport.cols}x${viewport.rows} is not supported by ${scenario.id}`,
    );
  }
}

async function setupAndRender(options: {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
  readonly fixture: FixtureLifecycle;
  readonly restoreEnvironment: () => void;
}): Promise<RenderFeatureResult> {
  try {
    await options.fixture.setup({
      scenario: options.scenario,
      checkpoint: options.checkpoint,
      viewport: options.viewport,
    });
    terminalSizeStore.__testReset({
      cols: options.viewport.cols,
      rows: options.viewport.rows,
      isSmall: options.viewport.cols < 120,
    });
    const projection = workflowFixtureProjections.get(options.scenario.id);
    const renderViewport: RenderViewport = {
      cols: options.viewport.cols,
      rows: options.viewport.rows,
    };
    const rendered = renderFeature(
      React.createElement<AppProps>(App, {
        workflowDeps: createWorkflowFixtureAppDeps(projection),
      }),
      renderViewport,
    );
    await flushEffects();
    return rendered;
  } catch (error) {
    return cleanupFailedMount({
      fixture: options.fixture,
      restoreEnvironment: options.restoreEnvironment,
      error,
    });
  }
}

async function unmountCapture(options: {
  readonly rendered: RenderFeatureResult;
  readonly fixture: FixtureLifecycle;
  readonly restoreEnvironment: () => void;
}): Promise<void> {
  try {
    options.rendered.unmount();
  } finally {
    try {
      await options.fixture.teardown();
    } finally {
      options.restoreEnvironment();
    }
  }
}

async function cleanupFailedMount(options: {
  readonly fixture: FixtureLifecycle;
  readonly restoreEnvironment: () => void;
  readonly error: unknown;
}): Promise<never> {
  try {
    await options.fixture.teardown();
  } catch (cleanupError) {
    throw new AggregateError([options.error, cleanupError], 'Gallery mount and cleanup failed');
  } finally {
    options.restoreEnvironment();
  }
  throw options.error;
}

async function unmountAfterFailure(unmount: () => Promise<void>, error: unknown): Promise<never> {
  try {
    await unmount();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Checkpoint wait and cleanup failed');
  }
  throw error;
}
