import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import type { Viewport } from '../contracts/geometry.js';
import type { ScenarioId } from '../contracts/identifiers.js';
import type { HomeScreenDeps } from '../../../src/app/screens/home.js';
import { trackProbe } from '../../../src/engine/probe-activity.js';

/**
 * What a preview says instead of reaching for an effect it cannot simulate. It lives beside the
 * fixture lifecycle types because both the session that builds the ports and the workflow fixture
 * that spends two of them spell the same refusal.
 */
export const PREVIEW_UNAVAILABLE = 'Unavailable in preview';

/**
 * The instant the fixture runs are dated from. The capture clock stands a little after it
 * (`testing/visual/gallery/environment.ts`), so every live clock a capture paints has counted.
 */
export const VISUAL_FIXTURE_EPOCH = 1_783_958_400_000;

/**
 * A composer draft longer than one row: its words wrap, and the path is longer than any input row,
 * so it hard-wraps. Home and the workflow screen paint the same draft.
 */
export const LONG_COMPOSER_DRAFT =
  'Keep the receiving flow as it is, but make the scanner screen show the last three pallets with their weights and the time each one was scanned. Read docs/specs/receiving/scanner-screen/pallet-weights-and-scan-history-v3-final-approved-by-the-operations-team.md before you start, and do not change the label printer.';

export interface FixtureContext {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
}

export type FixtureSetup = (context: FixtureContext) => void | Promise<void>;
export type FixtureTeardown = () => void | Promise<void>;

/**
 * The write an `afterMount` gets. `press` is the scripted-key form and resolves only once
 * the input has settled: the capture gates on a painted frame different from the one the
 * key started on, and a preview yields the React turns that apply the key. A replayed
 * sequence awaits it between keys so it cannot outrun the view.
 */
export interface FixtureWrite {
  (input: string): void;
  press(input: string): Promise<void>;
}

export interface FixtureLifecycle {
  readonly setup: FixtureSetup;
  readonly teardown: FixtureTeardown;
  /** Exercise the mounted view through its ordinary input path. */
  readonly afterMount?: (write: FixtureWrite) => void | Promise<void>;
  /** The preparation behind a start this scenario submits on home or setup. */
  readonly prepareExecution?: HomeScreenDeps['prepareExecution'];
}

export type FixtureFactory = () => FixtureLifecycle;
export type FixtureRegistry = ReadonlyMap<ScenarioId, FixtureFactory>;

export interface CheckpointPredicateContext {
  readonly output: string;
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
}

export type CheckpointPredicate = (context: CheckpointPredicateContext) => boolean;

/** Lists `run` as a probe that started twelve seconds before the scenario clock: a slow check. */
export function trackSlowProbe<T>(
  activity: Parameters<typeof trackProbe>[0],
  run: () => Promise<T>,
): Promise<T> {
  const fixedNow = Date.now;
  Date.now = () => fixedNow() - 12_000;
  try {
    return trackProbe(activity, run);
  } finally {
    Date.now = fixedNow;
  }
}
