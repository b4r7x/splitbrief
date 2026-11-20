import {
  getReviewPanelBudget,
  getWorkflowSidebarWidth,
} from '../../../src/features/workflow/layout/rect.js';
import { getReviewDocumentPromptRows } from '../../../src/features/workflow/prompt-rows/review-document.js';
import { getRecoveryPromptRows } from '../../../src/features/workflow/prompt-rows/recovery.js';
import {
  WORKFLOW_CHROME_ROWS,
  WORKFLOW_GUTTER_X,
} from '../../../src/features/workflow/layout/chrome-rows.js';
import { getHomeLayout, RESTING_DOCK_ROWS } from '../../../src/features/home/layout.js';
import {
  fixtureHalt,
  getWorkflowFixturePromptRows,
  type WorkflowFixtureProjection,
} from '../fixtures/workflow/projections.js';
import { workflowFixtureProjectionFor } from '../fixtures/workflow/registry.js';
import type { CellGrid } from '../contracts/cells.js';
import { CellRectSchema, type CellRect } from '../contracts/geometry.js';
import type { LocatorContext, LocatorDefinition } from './types.js';
import { resolveMarkerRect } from './markers.js';

const DEFAULT_INPUT_ROWS = 3;

const BASE_LOCATOR_REGISTRY: Record<string, LocatorDefinition> = {
  'home:heading': {
    kind: 'layout',
    description: 'Painted Home heading',
    resolve: resolveHomeHeading,
  },
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
    kind: 'layout',
    description: 'Complete approval panel bounds',
    resolve: resolveWorkflowApprovalPanel,
  },
  'workflow:activity': {
    kind: 'marker',
    description: 'Workflow activity block around its checkpoint marker',
    rowsAbove: 1,
    rowsBelow: 2,
  },
  'workflow:question-panel': {
    kind: 'layout',
    description: 'Complete question panel bounds',
    resolve: resolveWorkflowQuestionPanel,
  },
  'workflow:preparation-notice': {
    kind: 'marker',
    description: 'Continuation blocker above the composer',
    rowsAbove: 1,
    rowsBelow: 4,
  },
  'home:preparation-notice': {
    kind: 'layout',
    description: 'Start blocker with its keys and composer',
    resolve: resolveHomeComposer,
  },
  'workflow:preparation-panel': {
    kind: 'layout',
    description: 'Preparation problem panel terminal bounds',
    resolve: resolveFullFrame,
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

function gridRowText(row: CellGrid['cells'][number]): string {
  return row.map((cell) => cell.grapheme).join('');
}

function resolveHomeHeading({ grid }: LocatorContext): CellRect {
  const height = grid.cells.findIndex(
    (row, index) =>
      index > 0 &&
      (gridRowText(row).trim() === '' || gridRowText(row).trimStart().startsWith('PLAN ')),
  );
  if (height < 1) throw new Error('No Home heading above the crew');
  const lines = grid.cells.slice(0, height).map(gridRowText);
  const x = Math.min(...lines.map((line) => line.search(/\S/u)));
  const right = Math.max(...lines.map((line) => line.trimEnd().length));
  return CellRectSchema.parse({ x, y: 0, width: right - x, height });
}

function resolveHomeHeader(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows, dockRows: RESTING_DOCK_ROWS, noConfig: false });
  const end = context.grid.cells.findIndex((row) => gridRowText(row).includes('/crew to change'));
  if (end < 0) throw new Error('No Home crew status below the heading');
  return CellRectSchema.parse({
    x: Math.floor((cols - layout.width) / 2),
    y: 0,
    width: layout.width,
    height: end + 1,
  });
}

function resolveHomeComposer(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows, dockRows: RESTING_DOCK_ROWS, noConfig: false });
  const x = Math.floor((cols - layout.width) / 2);
  const boxBottom = rows - layout.inputBottomMargin - 1;
  // ASCII paints both corners with '+', so seek the top strictly above the known bottom.
  const topCorner = cellAt(context.grid, x, boxBottom) === '+' ? '+' : '╭';
  let boxTop = boxBottom - 1;
  while (boxTop > context.grid.rect.y && cellAt(context.grid, x, boxTop) !== topCorner) boxTop -= 1;
  if (cellAt(context.grid, x, boxTop) !== topCorner) {
    throw new Error('No home composer box is painted above the bottom margin');
  }
  let top = boxTop - 1;
  const noticeX = context.grid.cells[top]?.findIndex((cell) => cell.grapheme.trim() !== '');
  const edge = (y: number) => cellAt(context.grid, noticeX ?? -1, y);
  if (edge(top) === '╰' || edge(top) === '+') {
    while (top > 0 && (edge(top - 1) === '│' || edge(top - 1) === '|')) top--;
    if (edge(top - 1) === '╭' || edge(top - 1) === '+') top--;
  } else if (edge(top) === '▌' || edge(top) === '|') {
    while (top > 0 && edge(top - 1) === edge(top)) top--;
  }
  const status = context.grid.cells[top - 1];
  if (top < boxTop - 1 && status && gridRowText(status).trim() !== '') top--;
  return CellRectSchema.parse({ x, y: top, width: layout.width, height: boxBottom - top + 1 });
}

function cellAt(grid: CellGrid, x: number, y: number): string | undefined {
  return grid.cells[y - grid.rect.y]?.[x - grid.rect.x]?.grapheme;
}

function borderWidth(
  grid: CellGrid,
  x: number,
  y: number,
  stroke: string,
  end: string,
): number | undefined {
  let right = x + 1;
  while (cellAt(grid, right, y) === stroke) right++;
  return right > x + 1 && cellAt(grid, right, y) === end ? right - x + 1 : undefined;
}

function projectionFor(context: LocatorContext): WorkflowFixtureProjection {
  const projection = workflowFixtureProjectionFor(context.scenario.id, context.checkpoint.id);
  if (projection === undefined) {
    throw new Error(`Missing workflow fixture projection ${context.scenario.id}`);
  }
  return projection;
}

function sidebarWidthFor(context: LocatorContext): number {
  const { cols } = context.grid.identity.provenance.viewport;
  return getWorkflowSidebarWidth({ cols, sidebarVisible: projectionFor(context).sidebarVisible });
}

function isWorkflowDivider(row: CellGrid['cells'][number]): boolean {
  const first = row[0]?.grapheme;
  return (first === '─' || first === '-') && row.at(-1)?.grapheme === first;
}

function bodyTopRow({ grid }: LocatorContext): number {
  const divider = grid.cells.findIndex(isWorkflowDivider);
  if (divider < 0) throw new Error('No workflow header divider in the frame');
  return divider + 1;
}

function workflowFooterRows(context: LocatorContext): number {
  const { grid } = context;
  const divider = grid.cells.findLastIndex(isWorkflowDivider);
  if (divider >= bodyTopRow(context)) return grid.rect.height - divider;
  // A completion menu can cover the footer divider. Its top edge ends the visible panel.
  const composer = resolveWorkflowComposer(context);
  const x = composer.x;
  const corner = cellAt(grid, x, composer.y - 1);
  if (corner === '╰' || corner === '+') {
    const top = grid.cells.findLastIndex(
      (row, y) => y < composer.y - 1 && (row[x]?.grapheme === '╭' || row[x]?.grapheme === '+'),
    );
    if (top >= bodyTopRow(context)) return grid.rect.height - top;
  }
  return grid.rect.height - composer.y;
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
    height: rows - y - workflowFooterRows(context),
  });
}

function resolveWorkflowHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({ x: 0, y: 0, width: cols, height: bodyTopRow(context) });
}

function resolveWorkflowTranscript(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const bottom = rows - workflowFooterRows(context);
  // With no body row, the scroll count on the header divider represents the hidden transcript.
  const y = Math.min(bodyTopRow(context), bottom - 1);
  return CellRectSchema.parse({
    x: 0,
    y,
    width: cols,
    height: bottom - y,
  });
}

function resolveWorkflowComposer(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  // The workflow composer leaves a gutter at either edge of the terminal.
  return CellRectSchema.parse({
    x: WORKFLOW_GUTTER_X,
    y: rows - DEFAULT_INPUT_ROWS - 1,
    width: Math.max(1, cols - WORKFLOW_GUTTER_X * 2),
    height: DEFAULT_INPUT_ROWS,
  });
}

function resolveWorkflowApprovalPanel(context: LocatorContext): CellRect {
  resolveMarkerRect({
    grid: context.grid,
    marker: context.checkpoint.marker,
    bounds: context.grid.rect,
    selection: { kind: 'unique' },
  });
  const projection = projectionFor(context);
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const transcript = resolveWorkflowTranscript(context);
  const promptRows =
    projection.review !== undefined && projection.approval === undefined
      ? getReviewDocumentPromptRows(
          projection.reviewArtifact ?? null,
          projection.review.confirms ?? [],
          cols,
          getReviewPanelBudget({
            rows,
            inputRows: DEFAULT_INPUT_ROWS,
            feedbackRows:
              workflowFooterRows(context) -
              DEFAULT_INPUT_ROWS -
              WORKFLOW_CHROME_ROWS.inputFooter -
              WORKFLOW_CHROME_ROWS.footerDivider,
          }),
        )
      : getWorkflowFixturePromptRows(projection, cols);
  const height = Math.min(promptRows, transcript.height);
  const y = transcript.y + transcript.height - height;
  if (projection.approval || projection.approvalAfterMount) {
    const x = transcript.x + WORKFLOW_GUTTER_X;
    const left = cellAt(context.grid, x, y);
    const width =
      left === '┏'
        ? borderWidth(context.grid, x, y, '━', '┓')
        : left === '+'
          ? borderWidth(context.grid, x, y, '-', '+')
          : undefined;
    if (width !== undefined) return CellRectSchema.parse({ x, y, width, height });
  }
  return CellRectSchema.parse({ x: transcript.x, y, width: transcript.width, height });
}

function resolveWorkflowQuestionPanel(context: LocatorContext): CellRect {
  const projection = projectionFor(context);
  const { cols } = context.grid.identity.provenance.viewport;
  const transcript = resolveWorkflowTranscript(context);
  const halt = fixtureHalt(projection);
  const promptRows =
    halt !== undefined
      ? getRecoveryPromptRows(halt, cols)
      : getWorkflowFixturePromptRows(projection, cols);
  const height = Math.min(promptRows, transcript.height);
  return CellRectSchema.parse({
    x: transcript.x,
    y: transcript.y + transcript.height - height,
    width: transcript.width,
    height,
  });
}

// Both menus touch the composer. Their painted corners supply the width and height of the crop.
function resolveCompletionMenuAbove(context: LocatorContext, composer: CellRect): CellRect {
  const { grid } = context;
  const x = composer.x;
  const bottom = composer.y + composer.height - DEFAULT_INPUT_ROWS - 1;
  const ascii = cellAt(grid, x, bottom) === '+';
  const width = borderWidth(grid, x, bottom, ascii ? '-' : '─', ascii ? '+' : '╯');
  let top = bottom - 1;
  while (top > grid.rect.y && cellAt(grid, x, top) === (ascii ? '|' : '│')) top--;
  if (
    cellAt(grid, x, bottom) !== (ascii ? '+' : '╰') ||
    width === undefined ||
    cellAt(grid, x, top) !== (ascii ? '+' : '╭')
  ) {
    throw new Error('No completion menu is painted above the composer');
  }
  return CellRectSchema.parse({ x, y: top, width, height: bottom - top + 1 });
}

function resolveFullFrame(context: LocatorContext): CellRect {
  return CellRectSchema.parse(context.grid.rect);
}
