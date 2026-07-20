import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import type { Viewport } from '../contracts/geometry.js';
import type { ScenarioId } from '../contracts/identifiers.js';

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
}

export type FixtureFactory = () => FixtureLifecycle;
export type FixtureRegistry = ReadonlyMap<ScenarioId, FixtureFactory>;

export interface CheckpointPredicateContext {
  readonly output: string;
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
}

export type CheckpointPredicate = (context: CheckpointPredicateContext) => boolean;
