import {
  getWorkflowSidebarWidth,
  WORKFLOW_SIDEBAR_GAP,
} from '../../../src/features/workflow/layout/rect.js';
import { getHomeLayout, homeConfigBlockRows } from '../../../src/features/home/layout.js';
import { getLogoHeight } from '../../../src/features/home/logo.js';
import { overlayWidth } from '../../../src/core/navigation/overlay-rect.js';
import { listVisualScenarios } from '../catalog.js';
import { briefRecoveryFixtureProjections } from '../fixtures/workflow/brief-recovery-projections.js';
import { workflowFixtureProjections } from '../fixtures/workflow/projections.js';
import type { Cell, CellGrid } from '../contracts/cells.js';
import { CellRectSchema, type CellRect } from '../contracts/geometry.js';
import { resolveMarkerRect } from './markers.js';
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

const RECOVERY_LOCATOR_DEFINITIONS: Readonly<Record<string, LocatorDefinition>> = {
  'recovery-public-status': {
    kind: 'layout',
    description: 'Workflow status byline outside the recovery panel',
    resolve: resolveWorkflowStatusByline,
  },
  'recovery-status': {
    kind: 'layout',
    description: 'Recovery contract status row',
    resolve: resolveRecoveryStatusRow,
  },
  'recovery-evidence': {
    kind: 'layout',
    description: 'Recovery evidence revision row',
    resolve: resolveRecoveryEvidenceRow,
  },
  'recovery-cause': {
    kind: 'layout',
    description: 'Recovery cause row',
    resolve: resolveRecoveryCauseRow,
  },
  'recovery-actions': {
    kind: 'layout',
    description: 'Recovery action row',
    resolve: resolveRecoveryActionRow,
  },
  'recovery-composer': {
    kind: 'layout',
    description: 'Full-width recovery composer bounds',
    resolve: resolveWorkflowComposer,
  },
  'recovery-body': {
    kind: 'layout',
    description: 'Recovery workflow body bounds',
    resolve: resolveWorkflowTranscript,
  },
  'recovery-sidebar': {
    kind: 'layout',
    description: 'Recovery workflow sidebar bounds',
    resolve: resolveWorkflowSidebar,
  },
};

for (const scenario of listVisualScenarios()) {
  if (scenario.surface.kind !== 'screen' || scenario.surface.screen !== 'workflow') continue;
  if (!scenario.id.startsWith('workflow-brief-recovery-')) continue;

  for (const element of scenario.elements) {
    const key = `workflow:${element.id}`;
    if (BASE_LOCATOR_REGISTRY[key] !== undefined) continue;
    const definition = RECOVERY_LOCATOR_DEFINITIONS[element.id];
    if (definition === undefined) {
      throw new Error(`Missing recovery locator definition for ${element.id}`);
    }
    BASE_LOCATOR_REGISTRY[key] = definition;
  }
}

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

function sidebarWidthFor(context: LocatorContext): number {
  const { cols } = context.grid.identity.provenance.viewport;
  const projection =
    workflowFixtureProjections.get(context.scenario.id) ??
    briefRecoveryFixtureProjections.get(context.scenario.id);
  if (projection === undefined) {
    throw new Error(`Missing workflow fixture projection ${context.scenario.id}`);
  }
  return getWorkflowSidebarWidth({ cols, sidebarVisible: projection.sidebarVisible });
}

function resolveWorkflowSidebar(context: LocatorContext): CellRect {
  const { rows } = context.grid.identity.provenance.viewport;
  const width = sidebarWidthFor(context);
  if (width === 0) return resolveWorkflowHeader(context);
  return CellRectSchema.parse({
    x: 0,
    y: PAINTED_WORKFLOW_HEADER_ROWS,
    width,
    height: rows - PAINTED_WORKFLOW_HEADER_ROWS - DEFAULT_INPUT_ROWS - 3,
  });
}

function resolveWorkflowHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({ x: 0, y: 0, width: cols, height: PAINTED_WORKFLOW_HEADER_ROWS });
}

function resolveWorkflowTranscript(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const baseHeight = rows - PAINTED_WORKFLOW_HEADER_ROWS - DEFAULT_INPUT_ROWS - 3;
  return CellRectSchema.parse({
    x: 0,
    y: PAINTED_WORKFLOW_HEADER_ROWS,
    width: cols,
    height: Math.max(0, baseHeight),
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

// The evidence spine paints six consecutive content rows — status, evidence, cause,
// consequence, action, supplemental — so every spine element resolves to one row
// anchored on the cause row's `BECAUSE` label rather than to a shared band.
const RECOVERY_CAUSE_LABEL = 'BECAUSE';
const RECOVERY_ACTION_LABEL = 'NOW ';
const RECOVERY_STATUS_ROWS_ABOVE_CAUSE = 2;
const RECOVERY_EVIDENCE_ROWS_ABOVE_CAUSE = 1;

function resolveRecoveryContent(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  const body = resolveWorkflowTranscript(context);
  const sidebarWidth = sidebarWidthFor(context);
  const x = sidebarWidth === 0 ? 0 : sidebarWidth + WORKFLOW_SIDEBAR_GAP;
  return CellRectSchema.parse({ x, y: body.y, width: cols - x, height: body.height });
}

function resolveRecoveryRow(context: LocatorContext, label: string, rowsAbove: number): CellRect {
  const content = resolveRecoveryContent(context);
  const anchor = resolveMarkerRect({
    grid: context.grid,
    marker: label,
    bounds: content,
    selection: { kind: 'index', index: 0 },
  });
  return CellRectSchema.parse({
    x: content.x,
    y: anchor.y - rowsAbove,
    width: content.width,
    height: 1,
  });
}

function resolveRecoveryStatusRow(context: LocatorContext): CellRect {
  return resolveRecoveryRow(context, RECOVERY_CAUSE_LABEL, RECOVERY_STATUS_ROWS_ABOVE_CAUSE);
}

function resolveRecoveryEvidenceRow(context: LocatorContext): CellRect {
  return resolveRecoveryRow(context, RECOVERY_CAUSE_LABEL, RECOVERY_EVIDENCE_ROWS_ABOVE_CAUSE);
}

function resolveRecoveryCauseRow(context: LocatorContext): CellRect {
  return resolveRecoveryRow(context, RECOVERY_CAUSE_LABEL, 0);
}

function resolveRecoveryActionRow(context: LocatorContext): CellRect {
  return resolveRecoveryRow(context, RECOVERY_ACTION_LABEL, 0);
}

function resolveWorkflowStatusByline(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({ x: 0, y: rows - 1, width: cols, height: 1 });
}
