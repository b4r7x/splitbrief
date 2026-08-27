import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { CREW_LABEL_WIDTH, formatInheritedIdentity } from '../../core/crew/identity.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import { UNSET_EFFORT_WORD, type CrewRow } from '../../core/crew/rows.js';
import type { CrewSeat } from '../../core/crew/seats.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import { truncateTerminalDisplayText } from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';

export const CREW_COLUMN_GAP = '  ';
export const CREW_MARKER_GUTTER = 2;
/** Below this a truncated model id no longer names a model, so the posture tag yields the room. */
const MIN_IDENTITY_WIDTH = 28;

/** `unknown` is an unresolved posture, so it earns no tag instead of a guess. */
const POSTURE_TAGS: Readonly<Record<RunnerBillingPosture, string | undefined>> = {
  local: 'local',
  'subscription-included': 'subscription',
  'api-metered': 'metered',
  'provider-dependent': 'provider',
  unknown: undefined,
};

export interface SeatBlockLayout {
  identityWidth: number;
  posture: boolean;
  spines: boolean;
  verdict: boolean;
  rows: number;
}

/** The rail glyph and the gap that follows it: the column between the marker gutter and the label. */
export const CREW_RAIL_WIDTH = 2;
/** Inner column where every identity starts: cursor gutter, rail, the label and its gap. */
export const CREW_IDENTITY_COLUMN =
  CREW_MARKER_GUTTER + CREW_RAIL_WIDTH + CREW_LABEL_WIDTH + CREW_COLUMN_GAP.length;
/** The widest posture word plus the gap that separates it from the identity column. */
const CREW_POSTURE_COLUMN = 14;
const INHERITED_EFFORT_SUFFIX = ' · from planner';

export function planSeatBlock(
  input: Readonly<{
    rows: readonly CrewRow[];
    verdict: CrewLabVerdict | undefined;
    innerWidth: number;
    rowBudget: number;
  }>,
): SeatBlockLayout {
  const posture =
    input.innerWidth - CREW_IDENTITY_COLUMN - CREW_POSTURE_COLUMN >= MIN_IDENTITY_WIDTH;
  const identityWidth =
    input.innerWidth - CREW_IDENTITY_COLUMN - (posture ? CREW_POSTURE_COLUMN : 0);
  const spineRows = Math.max(0, input.rows.filter((row) => row.kind === 'seat').length - 1);

  let verdict = input.verdict !== undefined;
  let spines = true;
  const rowCount = (): number => input.rows.length + (spines ? spineRows : 0) + (verdict ? 1 : 0);

  if (rowCount() > input.rowBudget && verdict) verdict = false;
  if (rowCount() > input.rowBudget) spines = false;

  return { identityWidth, posture, spines, verdict, rows: rowCount() };
}

function seatContent(seat: CrewSeat, planner: RunnerConfig): string {
  return seat.id === 'review' && seat.source === 'planner'
    ? formatInheritedIdentity(planner)
    : seat.model;
}

function rowContent(row: CrewRow, planner: RunnerConfig): string {
  switch (row.kind) {
    case 'seat':
      return seatContent(row.seat, planner);
    case 'effort':
      return `${row.value ?? UNSET_EFFORT_WORD}${row.inherited ? INHERITED_EFFORT_SUFFIX : ''}`;
    default:
      return assertNever(row);
  }
}

function rowLabel(row: CrewRow): string {
  switch (row.kind) {
    case 'seat':
      return row.seat.label;
    case 'effort':
      return 'effort';
    default:
      return assertNever(row);
  }
}

function rowPosture(row: CrewRow): string | undefined {
  switch (row.kind) {
    case 'seat':
      return POSTURE_TAGS[row.seat.posture];
    case 'effort':
      return undefined;
    default:
      return assertNever(row);
  }
}

/**
 * While the spines stand the rail continues under every child (`mid`) except the review seat's own,
 * which closes the block; once the spines yield every child closes and the next seat starts fresh.
 */
function rowBranch(row: CrewRow, spines: boolean): 'node' | 'mid' | 'last' {
  if (row.kind === 'seat') return 'node';
  if (!spines) return 'last';
  return row.kind === 'effort' && row.seatId === 'review' ? 'last' : 'mid';
}

export function formatCrewRow(
  input: Readonly<{ row: CrewRow; layout: SeatBlockLayout; planner: RunnerConfig }>,
): Readonly<{
  label: string;
  content: string;
  posture?: string | undefined;
  branch: 'node' | 'mid' | 'last';
}> {
  const { row, layout } = input;
  const posture = layout.posture ? rowPosture(row) : undefined;
  return {
    label: rowLabel(row).padEnd(CREW_LABEL_WIDTH),
    content: truncateTerminalDisplayText(rowContent(row, input.planner), layout.identityWidth),
    ...(posture !== undefined && { posture }),
    branch: rowBranch(row, layout.spines),
  };
}
