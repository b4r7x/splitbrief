import { getWorkflowSidebarWidth } from '../../../src/features/workflow/layout/rect.js';
import {
  getProgressRows,
  WORKFLOW_GUTTER_X,
} from '../../../src/features/workflow/layout/chrome-rows.js';
import { getHomeLayout, homeConfigBlockRows } from '../../../src/features/home/layout.js';
import { getLogoHeight } from '../../../src/features/home/logo.js';
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
  'home:completion': {
    kind: 'layout',
    description: 'Completion menu opened above the home composer',
    resolve: (context) => resolveCompletionMenuAbove(context, resolveHomeComposer(context)),
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
    resolve: (context) => resolveCompletionMenuAbove(context, resolveWorkflowComposer(context)),
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
  'home:preparation-panel': {
    kind: 'layout',
    description: 'Preparation problem panel terminal bounds',
    resolve: resolveFullFrame,
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
    height: getLogoHeight(layout.logoTier) + 1 + homeConfigBlockRows(rows),
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
  // The sidebar is a box, so it stands on the gutter line rather than the terminal's first column.
  return CellRectSchema.parse({
    x: WORKFLOW_GUTTER_X,
    y,
    width,
    height: rows - y - DEFAULT_INPUT_ROWS - 3,
  });
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
  // The workflow composer renders inside the gutter: its box spans the terminal minus one gutter on
  // each side, so the card the completion locator walks shares those edge columns.
  return CellRectSchema.parse({
    x: WORKFLOW_GUTTER_X,
    y: rows - DEFAULT_INPUT_ROWS - 1,
    width: Math.max(1, cols - WORKFLOW_GUTTER_X * 2),
    height: DEFAULT_INPUT_ROWS,
  });
}

// The completion menu opens upward out of the composer, so its height follows the suggestion count
// and cannot be stated as a constant. It is a bordered card as wide as the composer and flush with
// the composer's input box, and the only thing painted there that carries a cell in both of the
// composer's edge columns, so walking that run upward measures the card the frame actually holds.
// A composer rect taller than the input box reserves rows above it — home's hint line — and the
// card paints over them, so the input box's top edge is where the card stops, not the rect's.
function resolveCompletionMenuAbove(context: LocatorContext, composer: CellRect): CellRect {
  const left = composer.x;
  const right = composer.x + composer.width - 1;
  const bottom = composer.y + composer.height - DEFAULT_INPUT_ROWS;
  let y = bottom;
  while (y > context.grid.rect.y && isCardRow(context.grid, y - 1, left, right)) y -= 1;
  if (y === bottom) {
    throw new Error('No completion menu is painted above the composer');
  }
  return CellRectSchema.parse({ x: composer.x, y, width: composer.width, height: bottom - y });
}

function isCardRow(grid: CellGrid, y: number, left: number, right: number): boolean {
  const row = grid.cells[y - grid.rect.y];
  if (row === undefined) return false;
  return isPaintedCell(row[left - grid.rect.x]) && isPaintedCell(row[right - grid.rect.x]);
}

function isPaintedCell(cell: Cell | undefined): boolean {
  return cell !== undefined && cell.grapheme.trim() !== '';
}

function resolveFullFrame(context: LocatorContext): CellRect {
  return CellRectSchema.parse(context.grid.rect);
}
