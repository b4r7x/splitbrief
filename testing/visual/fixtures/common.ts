import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import type { Viewport } from '../contracts/geometry.js';
import type { ScenarioId } from '../contracts/identifiers.js';
import type { ProviderCatalogOutcome } from '../../../src/engine/providers/types.js';

/**
 * What a preview says instead of reaching for an effect it cannot simulate. It lives beside the
 * fixture lifecycle types because both the session that builds the ports and the workflow fixture
 * that spends two of them spell the same refusal.
 */
export const PREVIEW_UNAVAILABLE = 'Unavailable in preview';

export interface FixtureContext {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
}

export type FixtureSetup = (context: FixtureContext) => void | Promise<void>;
export type FixtureTeardown = () => void | Promise<void>;

export interface FixtureLifecycle {
  readonly setup: FixtureSetup;
  readonly teardown: FixtureTeardown;
  /** Exercise the mounted view through its ordinary input path. */
  readonly afterMount?: (write: (input: string) => void) => void | Promise<void>;
  /** A synthetic answer for this scenario's local connection check. */
  readonly connectionOutcome?: ProviderCatalogOutcome;
}

export type FixtureFactory = () => FixtureLifecycle;
export type FixtureRegistry = ReadonlyMap<ScenarioId, FixtureFactory>;

export interface CheckpointPredicateContext {
  readonly output: string;
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
}

export type CheckpointPredicate = (context: CheckpointPredicateContext) => boolean;
