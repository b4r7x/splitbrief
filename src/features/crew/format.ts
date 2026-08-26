import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import {
  CREW_IDENTITY_SEPARATOR,
  CREW_LABEL_WIDTH,
  formatInheritedIdentity,
} from '../../core/crew/identity.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import { NO_ESCALATION_WORD, UNSET_EFFORT_WORD, type CrewRow } from '../../core/crew/rows.js';
import type { CrewEscalateEntry, CrewSeat } from '../../core/crew/seats.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import { glyph } from '../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
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
  foldEscalate: boolean;
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
  const foldable = input.rows.some((row) => row.kind === 'escalate');

  let verdict = input.verdict !== undefined;
  let spines = true;
  let foldEscalate = false;
  const rowCount = (): number =>
    input.rows.length - (foldEscalate ? 1 : 0) + (spines ? spineRows : 0) + (verdict ? 1 : 0);

  if (rowCount() > input.rowBudget && verdict) verdict = false;
  if (rowCount() > input.rowBudget) spines = false;
  if (rowCount() > input.rowBudget && foldable) foldEscalate = true;

  return { identityWidth, posture, spines, verdict, foldEscalate, rows: rowCount() };
}

/** The fold marker is the remedy, so the identity yields room for it; it is never cut in half. */
function foldEscalateInto(
  identity: string,
  escalate: CrewEscalateEntry,
  identityWidth: number,
): string {
  const short = sanitizeTerminalDisplayText(escalate.displayName);
  const marker = `${CREW_IDENTITY_SEPARATOR}${glyph('foldMarker')} ${short}`;
  const room = identityWidth - getTerminalCellWidth(marker);
  if (room <= 0) return identity;
  return `${truncateTerminalDisplayText(identity, room)}${marker}`;
}

function seatContent(seat: CrewSeat, planner: RunnerConfig, layout: SeatBlockLayout): string {
  const identity =
    seat.id === 'review' && seat.source === 'planner'
      ? formatInheritedIdentity(planner)
      : seat.model;
  if (!layout.foldEscalate || seat.id !== 'build' || seat.escalate === undefined) return identity;
  return foldEscalateInto(identity, seat.escalate, layout.identityWidth);
}

/** The filter matches the escalate row on its raw model id, so the row prints that same id. */
function escalateContent(entry: CrewEscalateEntry | undefined): string {
  if (entry === undefined) return NO_ESCALATION_WORD;
  return sanitizeTerminalDisplayText(
    `${entry.displayName}${CREW_IDENTITY_SEPARATOR}${entry.model}`,
  );
}

function rowContent(row: CrewRow, planner: RunnerConfig, layout: SeatBlockLayout): string {
  switch (row.kind) {
    case 'seat':
      return seatContent(row.seat, planner, layout);
    case 'effort':
      return `${row.value ?? UNSET_EFFORT_WORD}${row.inherited ? INHERITED_EFFORT_SUFFIX : ''}`;
    case 'escalate':
      return escalateContent(row.entry);
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
    case 'escalate':
      return 'escalate';
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
    case 'escalate':
      return row.entry === undefined ? undefined : POSTURE_TAGS[row.entry.posture];
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

/** A folded escalate row is spoken for by the BUILD row, so the block must not render it twice. */
export function visibleCrewRows(
  rows: readonly CrewRow[],
  layout: SeatBlockLayout,
): readonly CrewRow[] {
  if (!layout.foldEscalate) return rows;
  return rows.filter((row) => row.kind !== 'escalate');
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
    content: truncateTerminalDisplayText(
      rowContent(row, input.planner, layout),
      layout.identityWidth,
    ),
    ...(posture !== undefined && { posture }),
    branch: rowBranch(row, layout.spines),
  };
}
