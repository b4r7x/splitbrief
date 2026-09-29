import { App } from '../../../src/app/root.js';
import type { AppProps } from '../../../src/app/root.js';
import * as React from 'react';
import { performance } from 'node:perf_hooks';
import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import { ViewportSchema, type Viewport } from '../contracts/geometry.js';
import type { TerminalProfile } from '../contracts/manifest-fields.js';
import type { CheckpointPredicate, FixtureWrite } from '../fixtures/common.js';
import {
  flushEffects,
  renderFeature,
  type RenderFeatureResult,
  type RenderViewport,
} from '../../helpers/ink.js';
import { enterCaptureEnvironment } from './environment.js';
import { waitForCheckpoint } from './checkpoints.js';
import { createFixtureSession, type FixtureSession } from './fixture-session.js';

export interface MountGalleryScenarioOptions {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
  readonly profile?: TerminalProfile | undefined;
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

/**
 * A capture is the shared fixture session plus the two things only a capture has: the
 * deterministic environment its frames are compared under, and its own off-screen renderer.
 */
export async function mountGalleryScenario(
  options: MountGalleryScenarioOptions,
): Promise<GalleryCaptureHandle> {
  const viewport = ViewportSchema.parse(options.viewport);
  const environment = enterCaptureEnvironment({ viewport, profile: options.profile });
  let session: FixtureSession;
  try {
    session = await createFixtureSession({
      scenario: options.scenario,
      checkpoint: options.checkpoint,
      viewport,
    });
  } catch (error) {
    environment.restore();
    throw error;
  }

  const { scenario, checkpoint } = session;
  let rendered: RenderFeatureResult;
  try {
    rendered = await render(session.props, viewport);
  } catch (error) {
    return cleanupFailedMount(session, environment.restore, error);
  }

  let unmountPromise: Promise<void> | undefined;
  const unmount = (): Promise<void> => {
    unmountPromise ??= unmountCapture(rendered, session, environment.restore);
    return unmountPromise;
  };

  try {
    // The capture stdin emits synchronously and buffers nothing, so a write that lands
    // before Ink's useInput subscription settles is lost — the same contract
    // flushEffects documents for every other stdin.write in the suite.
    await flushEffects();
    await session.activate(captureInput(rendered, checkpoint.timeoutMs));
    await flushEffects();
  } catch (error) {
    return unmountAfterFailure(unmount, error);
  }

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

async function render(props: AppProps, viewport: Viewport): Promise<RenderFeatureResult> {
  const renderViewport: RenderViewport = { cols: viewport.cols, rows: viewport.rows };
  const rendered = renderFeature(React.createElement<AppProps>(App, props), renderViewport);
  await flushEffects();
  return rendered;
}

/**
 * The capture's stdin write plus its frame-gated form `press`: that key's promise resolves only
 * once the renderer has painted a frame different from the one the key started on. A replay that
 * gates every key through `press` cannot outrun the view (the archived race between a fixture's
 * keystrokes and the catalog render), and a key that changes nothing fails the capture loudly
 * instead of being photographed half-applied.
 */
function captureInput(rendered: RenderFeatureResult, timeoutMs: number): FixtureWrite {
  const write = (input: string): void => {
    rendered.stdin.write(input);
  };
  return Object.assign(write, {
    press: async (input: string): Promise<void> => {
      const before = rendered.lastFrame();
      rendered.stdin.write(input);
      const startedAt = performance.now();
      while (true) {
        await flushEffects();
        if (rendered.lastFrame() !== before) return;
        if (performance.now() - startedAt >= timeoutMs) {
          throw new Error(
            `Frame did not change after input ${JSON.stringify(input)} within ${timeoutMs}ms`,
          );
        }
      }
    },
  });
}

async function unmountCapture(
  rendered: RenderFeatureResult,
  session: FixtureSession,
  restoreEnvironment: () => void,
): Promise<void> {
  try {
    rendered.unmount();
  } finally {
    try {
      await session.dispose();
    } finally {
      restoreEnvironment();
    }
  }
}

async function cleanupFailedMount(
  session: FixtureSession,
  restoreEnvironment: () => void,
  error: unknown,
): Promise<never> {
  try {
    await session.dispose();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Gallery mount and cleanup failed');
  } finally {
    restoreEnvironment();
  }
  throw error;
}

async function unmountAfterFailure(unmount: () => Promise<void>, error: unknown): Promise<never> {
  try {
    await unmount();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Checkpoint wait and cleanup failed');
  }
  throw error;
}
