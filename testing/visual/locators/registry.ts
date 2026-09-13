import { getWorkflowSidebarWidth } from '../../../src/features/workflow/layout/rect.js';
import { getProgressRows } from '../../../src/features/workflow/layout/chrome-rows.js';
import { getHomeLayout, homeConfigBlockRows } from '../../../src/features/home/layout.js';
import { HOME_LOGO_ROWS } from '../../../src/features/home/logo.js';
import { overlayWidth } from '../../../src/core/navigation/overlay-rect.js';
import {
  workflowFixtureProjections,
  type WorkflowFixtureProjection,
} from '../fixtures/workflow/projections.js';
import { PhaseSchema, type Phase } from '../../../src/core/schemas/enums.js';
import type { Cell, CellGrid } from '../contracts/cells.js';
import { CellRectSchema, type CellRect } from '../contracts/geometry.js';
import type { LocatorContext, LocatorDefinition } from './types.js';

const DEFAULT_INPUT_ROWS = 3;
const PAINTED_WORKFLOW_HEADER_ROWS = 2;

const BASE_LOCATOR_REGISTRY: Record<string, LocatorDefinition> = {
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
  'workflow:completion': {
    kind: 'layout',
    description: 'Completion menu opened above the workflow composer',
    resolve: resolveCompletionMenu,
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
};

export const LOCATOR_REGISTRY: Readonly<Record<string, LocatorDefinition>> =
  Object.freeze(BASE_LOCATOR_REGISTRY);

function resolveHomeHeader(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows });
  return CellRectSchema.parse({
    x: Math.floor((cols - layout.width) / 2),
    y: 0,
    width: layout.width,
    height: HOME_LOGO_ROWS + 1 + homeConfigBlockRows(rows),
  });
}

function resolveHomeComposer(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows });
  const height = DEFAULT_INPUT_ROWS + 1;
  return CellRectSchema.parse({
    x: Math.floor((cols - layout.width) / 2),
    y: rows - layout.inputBottomMargin - height,
    width: layout.width,
    height,
  });
}

function projectionFor(context: LocatorContext): WorkflowFixtureProjection {
  const projection = workflowFixtureProjections.get(context.scenario.id);
  if (projection === undefined) {
    throw new Error(`Missing workflow fixture projection ${context.scenario.id}`);
  }
  return projection;
}

function sidebarWidthFor(context: LocatorContext): number {
  const { cols } = context.grid.identity.provenance.viewport;
  return getWorkflowSidebarWidth({ cols, sidebarVisible: projectionFor(context).sidebarVisible });
}

// The phase the screen is in at the checkpoint: the last event that carries one.
function checkpointPhase(projection: WorkflowFixtureProjection): Phase {
  for (let index = projection.events.length - 1; index >= 0; index -= 1) {
    const parsed = PhaseSchema.safeParse(projection.events[index]?.phase);
    if (parsed.success) return parsed.data;
  }
  return 'idle';
}

// The build-progress block rides between the rail and the divider, so the body's first row moves
// with the run's phase and width; a constant here would crop the block instead of the body.
function bodyTopRow(context: LocatorContext): number {
  const { cols } = context.grid.identity.provenance.viewport;
  return (
    PAINTED_WORKFLOW_HEADER_ROWS +
    getProgressRows({ phase: checkpointPhase(projectionFor(context)), cols })
  );
}

function resolveWorkflowSidebar(context: LocatorContext): CellRect {
  const { rows } = context.grid.identity.provenance.viewport;
  const width = sidebarWidthFor(context);
  if (width === 0) return resolveWorkflowHeader(context);
  const y = bodyTopRow(context);
  return CellRectSchema.parse({ x: 0, y, width, height: rows - y - DEFAULT_INPUT_ROWS - 3 });
}

function resolveWorkflowHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({ x: 0, y: 0, width: cols, height: PAINTED_WORKFLOW_HEADER_ROWS });
}

function resolveWorkflowTranscript(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const y = bodyTopRow(context);
  return CellRectSchema.parse({
    x: 0,
    y,
    width: cols,
    height: Math.max(0, rows - y - DEFAULT_INPUT_ROWS - 3),
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

// The completion menu opens upward out of the composer, so its height follows the suggestion count
// and cannot be stated as a constant. It is a bordered card flush with the composer's top edge, and
// the only thing painted there that carries a cell in both the frame's first and last column, so
// walking that run upward measures the card the frame actually holds.
function resolveCompletionMenu(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  const bottom = resolveWorkflowComposer(context).y;
  let y = bottom;
  while (y > context.grid.rect.y && isCardRow(context.grid, y - 1)) y -= 1;
  if (y === bottom) {
    throw new Error('No completion menu is painted above the workflow composer');
  }
  return CellRectSchema.parse({ x: 0, y, width: cols, height: bottom - y });
}

function isCardRow(grid: CellGrid, y: number): boolean {
  const row = grid.cells[y - grid.rect.y];
  if (row === undefined) return false;
  return isPaintedCell(row[0]) && isPaintedCell(row[row.length - 1]);
}

function isPaintedCell(cell: Cell | undefined): boolean {
  return cell !== undefined && cell.grapheme.trim() !== '';
}

function resolveSummaryHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  const width = overlayWidth({ cols, density: 'roomy' });
  return CellRectSchema.parse({
    x: Math.floor((cols - width) / 2),
    y: 1,
    width,
    height: cols < 120 ? 1 : 2,
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
