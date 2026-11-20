import {
  getReviewPanelBudget,
  getWorkflowSidebarWidth,
} from '../../../src/features/workflow/layout/rect.js';
import { getReviewDocumentPromptRows } from '../../../src/features/workflow/prompt-rows/review-document.js';
import { getRecoveryPromptRows } from '../../../src/features/workflow/prompt-rows/recovery.js';
import {
  getContentTopRowIndex,
  getProgressRows,
  WORKFLOW_CHROME_ROWS,
  WORKFLOW_GUTTER_X,
} from '../../../src/features/workflow/layout/chrome-rows.js';
import { layoutHomeNotice } from '../../../src/components/composer/home-hint.js';
import {
  getHomeLayout,
  homeConfigBlockRows,
  homeHeadingRows,
  RESTING_DOCK_ROWS,
} from '../../../src/features/home/layout.js';
import {
  fixtureHalt,
  getWorkflowFixturePromptRows,
  type WorkflowFixtureProjection,
} from '../fixtures/workflow/projections.js';
import { projectionChromeFacts } from '../fixtures/workflow/projection-chrome.js';
import {
  workflowFixtureFeedback,
  workflowFixtureProjectionFor,
} from '../fixtures/workflow/registry.js';
import { getFeedbackRows } from '../../../src/features/workflow/components/feedback-row.js';
import { homeFixtureFeedback } from '../fixtures/screen-fixtures.js';
import type { CellGrid } from '../contracts/cells.js';
import { CellRectSchema, type CellRect } from '../contracts/geometry.js';
import type { LocatorContext, LocatorDefinition } from './types.js';
import { resolveMarkerRect } from './markers.js';

const DEFAULT_INPUT_ROWS = 3;

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
    kind: 'marker',
    description: 'Start blocker above the composer',
    rowsAbove: 1,
    rowsBelow: 4,
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

function resolveHomeHeader(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const layout = getHomeLayout({ cols, rows, dockRows: RESTING_DOCK_ROWS, noConfig: false });
  return CellRectSchema.parse({
    x: Math.floor((cols - layout.width) / 2),
    y: 0,
    width: layout.width,
    height: homeHeadingRows(layout.heading) + homeConfigBlockRows(rows),
  });
}

// The crop is the dock the composer publishes to the home layout: its home rows over the box.
// The box rows come from the frame; the home rows from the fixture's notice, laid out as the
// composer lays it out.
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
  const notice = homeFixtureFeedback.get(context.scenario.id);
  const homeRows = notice === undefined ? 1 : layoutHomeNotice(notice, layout.width).height;
  const height = homeRows + boxBottom - boxTop + 1;
  return CellRectSchema.parse({ x, y: boxBottom + 1 - height, width: layout.width, height });
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

// The build-progress block rides between the rail and the divider, so the body's first row moves
// with the run's phase, width and the states that stand the block down; a constant here would crop
// the block instead of the body. The facts come from the projection the frame's screen was mounted
// from, the same facts the page and the snapshot hand to `getProgressRows`, and the top row comes
// from the chrome measure those callers use, not a second count of the header rows.
function bodyTopRow(context: LocatorContext): number {
  const { cols } = context.grid.identity.provenance.viewport;
  const facts = projectionChromeFacts(projectionFor(context), cols);
  return (
    getContentTopRowIndex() +
    getProgressRows({
      phase: facts.phase,
      cols,
      cancelled: facts.cancelled,
      halted: facts.halted,
      promptRows: facts.promptRows,
      atRest: facts.atRest,
      parked: facts.parked,
    })
  );
}

// The rows the fixture's message takes in the footer, fitted as the feedback row fits it.
function workflowFeedbackRows(context: LocatorContext): number {
  const { cols } = context.grid.identity.provenance.viewport;
  return getFeedbackRows(
    workflowFixtureFeedback.get(context.scenario.id) ?? { message: null, severity: 'info' },
    cols,
  );
}

// The body ends above the footer: its rule, the feedback rows, the composer and the byline.
function workflowFooterRows(context: LocatorContext): number {
  return (
    WORKFLOW_CHROME_ROWS.footerDivider +
    workflowFeedbackRows(context) +
    DEFAULT_INPUT_ROWS +
    WORKFLOW_CHROME_ROWS.inputFooter
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
    height: rows - y - workflowFooterRows(context),
  });
}

function resolveWorkflowHeader(context: LocatorContext): CellRect {
  const { cols } = context.grid.identity.provenance.viewport;
  return CellRectSchema.parse({ x: 0, y: 0, width: cols, height: getContentTopRowIndex() });
}

function resolveWorkflowTranscript(context: LocatorContext): CellRect {
  const { cols, rows } = context.grid.identity.provenance.viewport;
  const y = bodyTopRow(context);
  return CellRectSchema.parse({
    x: 0,
    y,
    width: cols,
    height: Math.max(0, rows - y - workflowFooterRows(context)),
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
            feedbackRows: workflowFeedbackRows(context),
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
