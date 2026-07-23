import type { ArtifactKey } from '../contracts/identifiers.js';
import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import type { CellGrid } from '../contracts/cells.js';
import type { CellRect, Viewport } from '../contracts/geometry.js';
import type { ElementId } from '../contracts/identifiers.js';

export const LOCATOR_FAILURE_CODE = {
  invalidContext: 'invalid-locator-context',
  invalidFrame: 'invalid-locator-frame',
  invalidName: 'invalid-locator-name',
  unsupported: 'unsupported-locator',
  notFound: 'locator-not-found',
  ambiguous: 'ambiguous-locator',
  invalidGeometry: 'invalid-locator-geometry',
  crossFrame: 'cross-frame-provenance',
} as const;

export type LocatorFailureCode = (typeof LOCATOR_FAILURE_CODE)[keyof typeof LOCATOR_FAILURE_CODE];

export interface LocatorProvenance {
  readonly scenarioId: string;
  readonly scenarioTitle: string;
  readonly fixtureVersion: number;
  readonly checkpointId: string;
  readonly viewport: Viewport;
  readonly sourceFrameKey: ArtifactKey;
}

export interface ResolvedElementLocator {
  readonly elementId: ElementId;
  readonly rect: CellRect;
  readonly kind: 'layout' | 'marker';
  readonly description: string;
  readonly provenance: LocatorProvenance;
}

export interface ResolveElementLocatorOptions {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly grid: CellGrid;
  readonly elementId: string;
}

export interface LocatorResolutionFailure {
  readonly code: LocatorFailureCode;
  readonly message: string;
  readonly elementId: string;
}

export type LocatorResolutionResult =
  | { readonly ok: true; readonly locator: ResolvedElementLocator }
  | { readonly ok: false; readonly failure: LocatorResolutionFailure };

export type MarkerSelection =
  | { readonly kind: 'unique' }
  | { readonly kind: 'index'; readonly index: number };

export interface ResolveMarkerRectOptions {
  readonly grid: CellGrid;
  readonly marker: string;
  readonly bounds: CellRect;
  readonly selection: MarkerSelection;
}

export interface LocatorContext {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly grid: CellGrid;
}

interface LayoutLocatorDefinition {
  readonly kind: 'layout';
  readonly description: string;
  readonly resolve: (context: LocatorContext) => CellRect;
}

interface MarkerLocatorDefinition {
  readonly kind: 'marker';
  readonly description: string;
  readonly rowsAbove: number;
  readonly rowsBelow: number;
}

export type LocatorDefinition = LayoutLocatorDefinition | MarkerLocatorDefinition;
