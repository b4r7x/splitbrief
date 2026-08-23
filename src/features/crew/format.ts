import type { CrewEscalateEntry, CrewSeat } from '../../core/crew/seats.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';

export const CREW_COLUMN_GAP = '  ';
/** The panel title and the hint each carry their own blank line. */
export const CREW_PANEL_CHROME_ROWS = 4;
export const CREW_MARKER_GUTTER = 2;
const LABEL_WIDTH = 6;
const MODEL_SEPARATOR = ' · ';
const PLANNER_POINTER = '= same as planner';
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

export type CrewRow = Readonly<{
  index?: string | undefined;
  label: string;
  identity: string;
  posture?: string | undefined;
}>;

function identityOf(displayName: string, model: string | undefined): string {
  const raw = model === undefined ? displayName : `${displayName}${MODEL_SEPARATOR}${model}`;
  return sanitizeTerminalDisplayText(raw);
}

function compose(
  input: Readonly<{
    prefixWidth: number;
    identity: string;
    posture: string | undefined;
    width: number;
  }>,
): Readonly<{ identity: string; posture?: string | undefined }> {
  const budget = input.width - input.prefixWidth;
  const postureCost =
    input.posture === undefined ? 0 : input.posture.length + CREW_COLUMN_GAP.length;
  const keepsPosture =
    input.posture !== undefined &&
    budget - postureCost >= Math.min(MIN_IDENTITY_WIDTH, input.identity.length);
  const identity = truncateWithEllipsis(
    input.identity,
    Math.max(0, budget - (keepsPosture ? postureCost : 0)),
  );
  return { identity, ...(keepsPosture && { posture: input.posture }) };
}

export function formatCrewSeatRow(
  input: Readonly<{ seat: CrewSeat; position: number; width: number }>,
): CrewRow {
  const { seat } = input;
  const index = String(input.position);
  const label = truncateWithEllipsis(
    seat.label.padEnd(LABEL_WIDTH),
    Math.max(0, input.width - index.length - CREW_COLUMN_GAP.length * 2),
  );
  const pointsAtPlanner = seat.id === 'review' && seat.source === 'planner';
  return {
    index,
    label,
    ...compose({
      prefixWidth: index.length + label.length + CREW_COLUMN_GAP.length * 2,
      identity: pointsAtPlanner ? PLANNER_POINTER : identityOf(seat.displayName, seat.model),
      posture: pointsAtPlanner ? undefined : POSTURE_TAGS[seat.posture],
      width: input.width,
    }),
  };
}

export function formatCrewEscalateRow(
  input: Readonly<{ escalate: CrewEscalateEntry; width: number }>,
): CrewRow {
  const label = truncateWithEllipsis(input.escalate.label, Math.max(0, input.width));
  return {
    label,
    ...compose({
      prefixWidth: label.length + CREW_COLUMN_GAP.length,
      identity: identityOf(input.escalate.displayName, input.escalate.model),
      posture: POSTURE_TAGS[input.escalate.posture],
      width: input.width,
    }),
  };
}
