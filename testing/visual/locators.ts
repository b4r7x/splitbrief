import { getWorkflowSidebarWidth } from '../../src/features/workflow/layout/rect.js';
import { TOP_FIXED_CHROME_ROWS } from '../../src/features/workflow/layout/chrome-rows.js';
import { getHomeLayout } from '../../src/features/home/layout.js';
import { getLogoHeight } from '../../src/features/home/logo.js';
import { splitTerminalGraphemes } from '../../src/utils/display-text.js';
import { getResponsivePanelWidth } from '../../src/utils/terminal-width.js';
import type { ArtifactKey } from './contracts/identifiers.js';
import {
  CheckpointDefinitionSchema,
  ScenarioDefinitionSchema,
  type CheckpointDefinition,
  type ScenarioDefinition,
} from './contracts/catalog.js';
import {
  CellGridSchema,
  isCellRectOnGraphemeBoundaries,
  type CellGrid,
} from './contracts/cells.js';
import { CellRectSchema, type CellRect, type Viewport } from './contracts/geometry.js';
import { ElementIdSchema, type ElementId } from './contracts/identifiers.js';

const DEFAULT_INPUT_ROWS = 3;

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

interface LocatorContext {
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

export const LOCATOR_REGISTRY: Readonly<Record<string, LocatorDefinition>> = Object.freeze({
  'home:header': {
    kind: 'layout',
    description: 'Home logo and runner summary bounds',
    resolve: resolveHomeHeader,
  },
  'home:hero': {
    kind: 'marker',
    description: 'Home recent-session hero around its empty-state marker',
    rowsAbove: 1,
    rowsBelow: 1,
  },
  'home:composer': {
    kind: 'layout',
    description: 'Home feature composer bounds',
    resolve: resolveHomeComposer,
  },
  'workflow:header': {
    kind: 'layout',
    description: 'Workflow header and phase rail bounds',
    resolve: resolveWorkflowHeader,
  },
  'workflow:transcript': {
    kind: 'layout',
    description: 'Workflow transcript column bounds',
    resolve: resolveWorkflowTranscript,
  },
  'workflow:sidebar': {
    kind: 'layout',
    description: 'Workflow sidebar or compact phase rail bounds',
    resolve: resolveWorkflowSidebar,
  },
  'workflow:composer': {
    kind: 'layout',
    description: 'Workflow composer layout bounds',
    resolve: resolveWorkflowComposer,
  },
  'workflow:approval-panel': {
    kind: 'marker',
    description: 'Approval panel around its checkpoint marker',
    rowsAbove: 2,
    rowsBelow: 2,
  },
  'workflow:activity': {
    kind: 'marker',
    description: 'Workflow activity block around its checkpoint marker',
    rowsAbove: 1,
    rowsBelow: 2,
  },
  'workflow:question-panel': {
    kind: 'marker',
    description: 'Question panel around its checkpoint marker',
    rowsAbove: 1,
    rowsBelow: 3,
  },
  'summary:header': {
    kind: 'layout',
    description: 'Summary heading and workflow byline bounds',
    resolve: resolveSummaryHeader,
  },
  'summary:summary-hero': {
    kind: 'marker',
    description: 'Summary hero around its outcome marker',
    rowsAbove: 2,
    rowsBelow: 2,
  },
  'summary:summary-details': {
    kind: 'layout',
    description: 'Summary run details and evidence bounds',
    resolve: resolveSummaryDetails,
  },
  'setup:header': {
    kind: 'marker',
    description: 'Setup step header at its checkpoint marker',
    rowsAbove: 0,
    rowsBelow: 0,
  },
  'setup:setup-panel': {
    kind: 'layout',
    description: 'Setup panel terminal bounds',
    resolve: resolveFullFrame,
  },
  'overlay:overlay-panel': {
    kind: 'layout',
    description: 'Active overlay terminal bounds',
    resolve: resolveFullFrame,
  },
});

function resolveHomeHeader(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows, isSmall: cols < 120 });
  return CellRectSchema.parse({
    x: Math.floor((cols - layout.bodyWidth) / 2),
    y: 0,
    width: layout.bodyWidth,
    height: getLogoHeight(layout.logoTier) + 2,
  });
}

function resolveHomeComposer(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows, isSmall: cols < 120 });
  const height = DEFAULT_INPUT_ROWS + 1;
  return CellRectSchema.parse({
    x: Math.floor((cols - layout.inputWidth) / 2),
    y: rows - layout.inputBottomMargin - height,
    width: layout.inputWidth,
    height,
  });
}

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

function fitRectToGraphemeBoundaries(grid: CellGrid, rect: CellRect): CellRect {
  let x = rect.x;
  let right = rect.x + rect.width;
  const firstRow = rect.y - grid.rect.y;
  const lastRow = firstRow + rect.height;
  const rows = grid.cells.slice(firstRow, lastRow);

  while (x < right && rows.some((row) => row[x]?.continuation)) {
    x += 1;
  }
  while (
    right > x &&
    rows.some((row) => {
      const cell = row[right - 1];
      return cell !== undefined && !cell.continuation && cell.width === 2;
    })
  ) {
    right -= 1;
  }

  if (right <= x) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator rectangle cannot be aligned to terminal grapheme boundaries',
    );
  }
  const aligned = CellRectSchema.parse({ ...rect, x, width: right - x });
  if (!isCellRectOnGraphemeBoundaries(grid.cells, aligned)) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator rectangle splits a terminal grapheme',
    );
  }
  return aligned;
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

export function resolveMarkerRect(options: ResolveMarkerRectOptions): CellRect {
  const grid = parseGrid(options.grid);
  const bounds = clipCellRect(options.bounds, grid.rect);
  const graphemes = splitTerminalGraphemes(options.marker);
  if (graphemes.length === 0 || graphemes.join('') !== options.marker) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidContext,
      'Marker must be non-empty terminal text',
    );
  }

  const matches = findMarkerMatches({ grid, bounds, graphemes });
  if (options.selection.kind === 'unique') {
    if (matches.length === 0) {
      throw locatorError(
        LOCATOR_FAILURE_CODE.notFound,
        'Marker has no match in its bounded region',
      );
    }
    if (matches.length > 1) {
      throw locatorError(
        LOCATOR_FAILURE_CODE.ambiguous,
        `Marker has ${matches.length} matches in its bounded region`,
      );
    }
    const match = matches[0];
    if (!match) throw locatorError(LOCATOR_FAILURE_CODE.notFound, 'Marker match is unavailable');
    return match;
  }

  if (!Number.isInteger(options.selection.index) || options.selection.index < 0) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Explicit marker index must be a non-negative integer',
    );
  }
  const match = matches[options.selection.index];
  if (!match) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.notFound,
      `Marker index ${options.selection.index} is outside ${matches.length} matches`,
    );
  }
  return match;
}

export function clipCellRect(rect: CellRect, bounds: CellRect): CellRect {
  const parsedRect = CellRectSchema.safeParse(rect);
  const parsedBounds = CellRectSchema.safeParse(bounds);
  if (!parsedRect.success || !parsedBounds.success) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator and frame rectangles require non-negative origins and positive dimensions',
    );
  }

  const x = Math.max(parsedRect.data.x, parsedBounds.data.x);
  const y = Math.max(parsedRect.data.y, parsedBounds.data.y);
  const right = Math.min(
    parsedRect.data.x + parsedRect.data.width,
    parsedBounds.data.x + parsedBounds.data.width,
  );
  const bottom = Math.min(
    parsedRect.data.y + parsedRect.data.height,
    parsedBounds.data.y + parsedBounds.data.height,
  );
  if (right <= x || bottom <= y) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator rectangle does not intersect its source frame',
    );
  }
  return CellRectSchema.parse({ x, y, width: right - x, height: bottom - y });
}

function resolveWorkflowSidebar(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const width = getWorkflowSidebarWidth({ cols, sidebarVisible: true, isSmall: cols < 120 });
  if (width === 0) return resolveWorkflowHeader(context);
  return CellRectSchema.parse({
    x: 0,
    y: TOP_FIXED_CHROME_ROWS,
    width,
    height: rows - TOP_FIXED_CHROME_ROWS - DEFAULT_INPUT_ROWS - 3,
  });
}

function resolveWorkflowHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({ x: 0, y: 0, width: cols, height: TOP_FIXED_CHROME_ROWS });
}

function resolveWorkflowTranscript(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({
    x: 0,
    y: TOP_FIXED_CHROME_ROWS,
    width: cols,
    height: rows - TOP_FIXED_CHROME_ROWS - DEFAULT_INPUT_ROWS - 3,
  });
}

function resolveWorkflowComposer(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({
    x: 0,
    y: rows - DEFAULT_INPUT_ROWS - 1,
    width: cols,
    height: DEFAULT_INPUT_ROWS,
  });
}

function resolveSummaryHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  const isSmall = cols < 120;
  const width = getResponsivePanelWidth({
    cols,
    size: isSmall ? 'small' : 'large',
    widths: { small: 64, large: 96 },
    gutter: 2,
  });
  return CellRectSchema.parse({
    x: Math.floor((cols - width) / 2),
    y: 1,
    width,
    height: isSmall ? 1 : 2,
  });
}

function resolveSummaryDetails(context: LocatorContext): CellRect {
  const { rows } = context.grid.identity.provenance.viewport;
  const header = resolveSummaryHeader(context);
  const y = header.y + header.height;
  return CellRectSchema.parse({
    x: header.x,
    y,
    width: header.width,
    height: rows - y - 5,
  });
}

function resolveFullFrame(context: LocatorContext): CellRect {
  return CellRectSchema.parse(context.grid.rect);
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

function findMarkerMatches(options: {
  readonly grid: CellGrid;
  readonly bounds: CellRect;
  readonly graphemes: readonly string[];
}): CellRect[] {
  const matches: CellRect[] = [];
  const maxY = options.bounds.y + options.bounds.height;
  const maxX = options.bounds.x + options.bounds.width;
  for (let y = options.bounds.y; y < maxY; y += 1) {
    for (let x = options.bounds.x; x < maxX; x += 1) {
      const width = markerWidthAt({ ...options, x, y, maxX });
      if (width !== null) matches.push(CellRectSchema.parse({ x, y, width, height: 1 }));
    }
  }
  return matches;
}

function markerWidthAt(options: {
  readonly grid: CellGrid;
  readonly graphemes: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly maxX: number;
}): number | null {
  const row = options.grid.cells[options.y - options.grid.rect.y];
  if (!row) return null;
  let column = options.x;
  for (const grapheme of options.graphemes) {
    if (column >= options.maxX) return null;
    const cell = row[column - options.grid.rect.x];
    if (!cell || cell.continuation || cell.grapheme !== grapheme) return null;
    column += cell.width;
  }
  return column - options.x;
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
