import {
  CheckpointDefinitionSchema,
  ScenarioDefinitionSchema,
  type CheckpointDefinition,
  type ScenarioDefinition,
} from '../contracts/catalog.js';
import { CellGridSchema, type CellGrid } from '../contracts/cells.js';
import { CellRectSchema, type CellRect } from '../contracts/geometry.js';
import { ElementIdSchema } from '../contracts/identifiers.js';
import { clipCellRect, fitRectToGraphemeBoundaries, resolveMarkerRect } from './markers.js';
import { LOCATOR_REGISTRY } from './registry.js';
import {
  LOCATOR_FAILURE_CODE,
  type LocatorContext,
  type LocatorFailureCode,
  type LocatorResolutionResult,
  type ResolveElementLocatorOptions,
  type ResolvedElementLocator,
} from './types.js';

export function resolveElementLocator(
  options: ResolveElementLocatorOptions,
): ResolvedElementLocator {
  const scenario = parseScenario(options.scenario);
  const checkpoint = parseCheckpoint(options.checkpoint);
  const grid = parseGrid(options.grid);
  assertSourceFrame(grid);
  const parsedElementId = ElementIdSchema.safeParse(options.elementId);
  if (!parsedElementId.success) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidName,
      'Element name is not a valid catalog element ID',
    );
  }
  const elementId = parsedElementId.data;
  if (!scenario.elements.some((element) => element.id === elementId)) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidName,
      `Element ${elementId} is not declared by scenario ${scenario.id}`,
    );
  }

  assertFrameProvenance({ scenario, checkpoint, grid });
  const registryKey = `${surfaceName(scenario)}:${elementId}`;
  const definition = LOCATOR_REGISTRY[registryKey];
  if (!definition) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.unsupported,
      `No semantic locator is registered for ${registryKey}`,
    );
  }

  const context = { scenario, checkpoint, grid };
  const semanticRect =
    definition.kind === 'layout'
      ? clipCellRect(definition.resolve(context), grid.rect)
      : resolveMarkerBand({
          context,
          rowsAbove: definition.rowsAbove,
          rowsBelow: definition.rowsBelow,
        });
  const rect = fitRectToGraphemeBoundaries(grid, semanticRect);

  return {
    elementId,
    rect,
    kind: definition.kind,
    description: definition.description,
    provenance: {
      ...grid.identity.provenance,
      sourceFrameKey: grid.identity.key,
    },
  };
}

export function tryResolveElementLocator(
  options: ResolveElementLocatorOptions,
): LocatorResolutionResult {
  try {
    return { ok: true, locator: resolveElementLocator(options) };
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: locatorFailureCode(error),
        message: error instanceof Error ? error.message : 'Locator resolution failed',
        elementId: options.elementId,
      },
    };
  }
}

function resolveMarkerBand(options: {
  readonly context: LocatorContext;
  readonly rowsAbove: number;
  readonly rowsBelow: number;
}): CellRect {
  const markerRect = resolveMarkerRect({
    grid: options.context.grid,
    marker: options.context.checkpoint.marker,
    bounds: options.context.grid.rect,
    selection: { kind: 'unique' },
  });
  const frame = options.context.grid.rect;
  const y = Math.max(frame.y, markerRect.y - options.rowsAbove);
  const bottom = Math.min(
    frame.y + frame.height,
    markerRect.y + markerRect.height + options.rowsBelow,
  );
  return CellRectSchema.parse({ x: frame.x, y, width: frame.width, height: bottom - y });
}

function assertFrameProvenance(context: LocatorContext): void {
  const { scenario, checkpoint, grid } = context;
  const provenance = grid.identity.provenance;
  const checkpointBelongsToScenario = scenario.checkpoints.some(
    (candidate) =>
      candidate.id === checkpoint.id &&
      candidate.kind === checkpoint.kind &&
      candidate.marker === checkpoint.marker,
  );
  const viewportBelongsToScenario = scenario.viewports.some(
    (candidate) =>
      candidate.cols === provenance.viewport.cols && candidate.rows === provenance.viewport.rows,
  );
  if (
    !checkpointBelongsToScenario ||
    !viewportBelongsToScenario ||
    provenance.scenarioId !== scenario.id ||
    provenance.scenarioTitle !== scenario.title ||
    provenance.fixtureVersion !== scenario.fixtureVersion ||
    provenance.checkpointId !== checkpoint.id
  ) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.crossFrame,
      'Scenario, checkpoint, viewport, and source frame provenance must identify one frame',
    );
  }
}

function surfaceName(scenario: ScenarioDefinition): string {
  return scenario.surface.kind === 'screen' ? scenario.surface.screen : 'overlay';
}

function parseScenario(value: ScenarioDefinition): ScenarioDefinition {
  const parsed = ScenarioDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    throw locatorError(LOCATOR_FAILURE_CODE.invalidContext, 'Scenario definition is invalid');
  }
  return parsed.data;
}

function parseCheckpoint(value: CheckpointDefinition): CheckpointDefinition {
  const parsed = CheckpointDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    throw locatorError(LOCATOR_FAILURE_CODE.invalidContext, 'Checkpoint definition is invalid');
  }
  return parsed.data;
}

function parseGrid(value: CellGrid): CellGrid {
  const parsed = CellGridSchema.safeParse(value);
  if (!parsed.success) {
    throw locatorError(LOCATOR_FAILURE_CODE.invalidFrame, 'Cell grid is invalid');
  }
  return parsed.data;
}

function assertSourceFrame(grid: CellGrid): asserts grid is CellGrid & {
  readonly identity: Extract<CellGrid['identity'], { readonly kind: 'frame' }>;
} {
  if (grid.identity.kind !== 'frame') {
    throw locatorError(
      LOCATOR_FAILURE_CODE.crossFrame,
      'Semantic locators require a canonical source frame',
    );
  }
}

function locatorError(code: LocatorFailureCode, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

function locatorFailureCode(error: unknown): LocatorFailureCode {
  if (!(error instanceof Error)) return LOCATOR_FAILURE_CODE.invalidContext;
  return (
    Object.values(LOCATOR_FAILURE_CODE).find((code) => code === error.name) ??
    LOCATOR_FAILURE_CODE.invalidContext
  );
}
