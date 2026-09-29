import {
  ELLIPSIS,
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { getRunnerDisplayName, type RunnerConfig } from '../config/accessors/runner-config.js';
import { formatModelName, peelDisplayLabel } from '../model-display.js';
import { getProviderDisplayName, getRunnerIdentityDisplayName } from '../providers/catalog.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../providers/automatic-model.js';
import type { RunnerKind } from '../schemas/enums.js';
import { SOFT_SEP } from '../separators.js';
import { CLI_TOOL_CATALOG, isCliToolId } from '../runners/cli-tool-catalog.js';
import { peelAxisTokensFromModelId, seatAxisWords } from '../runners/effort-channel.js';

export const CREW_SEAT_IDS = ['plan', 'build', 'review'] as const;

export type CrewSeatId = (typeof CREW_SEAT_IDS)[number];

export const CREW_SEAT_LABELS: Readonly<Record<CrewSeatId, string>> = {
  plan: 'PLAN',
  build: 'BUILD',
  review: 'REVIEW',
};

/** Seat labels are padded to this width so every identity column starts at one offset. */
export const CREW_LABEL_WIDTH = 8;

/** `model: auto` stays this word on the configuration surfaces; a run's own record names the model the tool selected. */
export const AUTO_MODEL_WORD = 'auto';

export const PLANNER_INHERITANCE = Object.freeze({
  sentence: 'same as planner',
  mark: '= PLAN',
});

/** The one middle dot that joins the parts of every crew identity, on the row and in the fold marker. */
export const CREW_IDENTITY_SEPARATOR = SOFT_SEP;
const CLAUDE_BRAND = 'Claude';
const HANGING_SEPARATOR = /[ ·]+$/u;

/**
 * A seat named by ids rather than by its runner block: the tool or provider id
 * (`getRunnerDisplayName`), the configured model, the axis words the seat
 * carries and the backend it ran on. A run records its seats this way, and both
 * forms below read a configured runner through the same shape, so a recorded
 * seat is spelled exactly as the seat it was taken from.
 */
export type SeatIds = Readonly<{
  tool: string;
  model?: string | undefined;
  axes?: readonly string[] | undefined;
  /** The backend the seat ran on; a record written before kinds were kept has none. */
  kind?: RunnerKind | undefined;
}>;

export function seatIdsOf(runner: RunnerConfig): SeatIds & Readonly<{ axes: readonly string[] }> {
  return {
    tool: getRunnerDisplayName(runner),
    ...('model' in runner && runner.model !== undefined && { model: runner.model }),
    axes: seatAxisWords(runner),
    kind: runner.kind,
  };
}

/**
 * Recorded ids are the shape that carries axis words: `seatIdsOf` always writes
 * them and the persisted schema requires them, while a live runner block never
 * has any. Ids written by hand may keep neither axes nor kind, so an object
 * without a kind is recorded ids too.
 */
function isSeatIds(seat: RunnerConfig | SeatIds): seat is SeatIds {
  if ('axes' in seat) return true;
  if (!('kind' in seat)) return true;
  // A live cli runner and a recorded cli identity both name a tool, so only the axis
  // words above tell those apart — and only for a catalog tool: the live schema admits
  // catalog ids alone, so a kind-qualified cli record whose tool left the catalog is a
  // record, never a live block whose axis lookup would dereference an absent entry.
  // Every other kind's live block is named by its own fields (an api runner by provider,
  // a command runner by command), never by the tool word a recorded identity keeps, so a
  // kind-qualified record without axes is still ids.
  return 'tool' in seat && (seat.kind !== 'cli' || !isCliToolId(seat.tool));
}

function idsOf(seat: RunnerConfig | SeatIds): SeatIds {
  return isSeatIds(seat) ? seat : seatIdsOf(seat);
}

/**
 * The backend kind of a seat: a live runner block names it, and a recorded
 * identity keeps the kind it was recorded with, or the one the caller recovered.
 */
function runnerKindOf(seat: RunnerConfig | SeatIds): RunnerKind | undefined {
  return seat.kind;
}

/**
 * The tool word of a seat identity. A custom API provider keeps its literal
 * name even when it reuses a CLI tool id; every other identity resolves through
 * the merged catalog exactly as before.
 */
function toolWord(seat: SeatIds, kind: RunnerKind | undefined): string {
  return kind === 'api'
    ? getRunnerIdentityDisplayName(kind, seat.tool)
    : getProviderDisplayName(seat.tool);
}

function modelWord(
  seat: SeatIds,
  displayName: string | undefined,
  kind: RunnerKind | undefined,
): string {
  // Only a CLI seat — or an identity recorded before kinds — reads the CLI
  // tool's model-id vocabulary; an API seat that reuses a tool id does not.
  const tool =
    (kind === undefined || kind === 'cli') && isCliToolId(seat.tool) ? seat.tool : undefined;
  const model = normalizeConfiguredModel(seat.model, tool);
  if (model === undefined || model === AUTOMATIC_MODEL) return AUTO_MODEL_WORD;
  if (tool !== undefined && CLI_TOOL_CATALOG[tool].effortChannel === 'model-id') {
    const peeled = displayName ? peelDisplayLabel(displayName) : '';
    if (peeled !== '') return peeled;
    return formatModelName(peelAxisTokensFromModelId(model));
  }
  if (displayName) return displayName;
  return formatModelName(model);
}

export function formatSeatIdentity(input: {
  seat: RunnerConfig | SeatIds;
  displayName?: string | undefined;
  kind?: RunnerKind | undefined;
}): string {
  const { seat, displayName, kind } = input;
  const ids = idsOf(seat);
  const resolvedKind = kind ?? runnerKindOf(seat);
  return sanitizeTerminalDisplayText(
    [
      toolWord(ids, resolvedKind),
      modelWord(ids, displayName, resolvedKind),
      ...(ids.axes ?? []),
    ].join(CREW_IDENTITY_SEPARATOR),
  );
}

/** The collapsed form: the brand is implied by the seat, so it is the one word dropped. */
export function formatShortSeatIdentity(input: {
  seat: RunnerConfig | SeatIds;
  displayName?: string | undefined;
  kind?: RunnerKind | undefined;
}): string {
  const { seat, displayName, kind } = input;
  const words = sanitizeTerminalDisplayText(
    modelWord(idsOf(seat), displayName, kind ?? runnerKindOf(seat)),
  )
    .split(' ')
    .filter(Boolean);
  const stripped = words[0] === CLAUDE_BRAND ? words.slice(1) : words;
  const rest = stripped.length === 0 ? words : stripped;
  return rest.join(' ');
}

/**
 * A tool this seat could move to, named before it is configured: the same
 * `<tool> · <model>` shape a configured seat shows, composed from ids and the
 * model's catalog label because a swap candidate is two strings, not a runner
 * block. A candidate that names no model is the tool's own default and says
 * only the tool.
 */
export function formatSeatCandidateIdentity(
  candidate: Readonly<{ tool: string; model?: string | undefined }>,
  displayName?: string | undefined,
): string {
  const words = [getProviderDisplayName(candidate.tool)];
  if (candidate.model !== undefined) words.push(displayName ?? formatModelName(candidate.model));
  return sanitizeTerminalDisplayText(words.join(CREW_IDENTITY_SEPARATOR));
}

type CollapsedSeat = Readonly<{
  label: string;
  identity: string;
  named: boolean;
  /** A condition the seat carries while it lasts, parenthesized so it binds to this seat and not the next. */
  note?: string | undefined;
}>;

function collapsedSeatText(seat: CollapsedSeat): string {
  if (seat.note === undefined) return `${seat.label} ${seat.identity}`;
  return `${seat.label} ${seat.identity} (${seat.note})`;
}

// An elided seat leaves the line entirely. `REVIEW …` names no seat and reads as "pending" beside
// the workflow rail, so the seats that still fit are stated and the rest are silent.
function collapsedSeatLine(seats: readonly CollapsedSeat[], elided: ReadonlySet<number>): string {
  return seats
    .filter((_seat, index) => !elided.has(index))
    .map(collapsedSeatText)
    .join(CREW_IDENTITY_SEPARATOR);
}

/**
 * A seat that overruns the line loses its whole identity: half a model name
 * spells another model. The line hides the fewest names it can, and when more
 * than one name would buy the fit it spends the seat furthest along the line —
 * the planner leads and is the last to go anonymous — so which seat is named
 * does not change as the terminal is dragged a column. A budget that leaves no
 * name standing buys no line at all: labels and ellipses state nothing, and
 * beside the workflow rail an ellipsis already reads as "pending".
 */
function elideCollapsedSeats(seats: readonly CollapsedSeat[], budget: number): string {
  const lastFirst = seats
    .map((seat, index) => ({ index, width: getTerminalCellWidth(seat.identity) }))
    .reverse();
  const elided = new Set<number>();
  const fitsWithout = (index: number): boolean =>
    getTerminalCellWidth(collapsedSeatLine(seats, new Set([...elided, index]))) <= budget;
  while (
    elided.size < seats.length &&
    getTerminalCellWidth(collapsedSeatLine(seats, elided)) > budget
  ) {
    const remaining = lastFirst.filter((seat) => !elided.has(seat.index));
    // A note sits beside a name or not at all, so the seat carrying one is never
    // the seat elided: the line reports the failure instead and is measured again
    // without any notes.
    const pool = remaining.filter((seat) => seats[seat.index]?.note === undefined);
    if (pool.length === 0) return '';
    // When no single name is enough, the widest goes and the line is measured
    // again, so the line never hides more names than it has to.
    const chosen =
      pool.find((seat) => fitsWithout(seat.index)) ??
      pool.reduce((widest, seat) => (seat.width > widest.width ? seat : widest));
    elided.add(chosen.index);
  }
  const namesSomeone = seats.some((seat, index) => seat.named && !elided.has(index));
  return namesSomeone ? collapsedSeatLine(seats, elided) : '';
}

/**
 * A note outranks the names of the seats it does not belong to: it says what is
 * happening right now, and the elision rule already spends those names to buy
 * room. What it never outranks is its own seat's name — a clock beside `BUILD …`
 * names no seat — so a budget that cannot seat the noted name drops every note
 * and lays the plain line out instead.
 */
function fitCollapsedSeats(seats: readonly CollapsedSeat[], budget: number): string {
  const noted = elideCollapsedSeats(seats, budget);
  if (seats.every((seat) => seat.note === undefined)) return noted;
  if (noted !== '' && getTerminalCellWidth(noted) <= budget) return noted;
  return elideCollapsedSeats(
    seats.map((seat) => ({ label: seat.label, identity: seat.identity, named: seat.named })),
    budget,
  );
}

export function formatCollapsedSeatLine(
  input: Readonly<{
    planner: RunnerConfig;
    build: RunnerConfig;
    reviewer: RunnerConfig | undefined;
    budget?: number | undefined;
    /** What each seat is carrying right now, e.g. the reset clock of a quota-blocked seat. */
    notes?: Partial<Record<CrewSeatId, string>> | undefined;
    displayNames?:
      | Readonly<{
          planner?: string | undefined;
          build?: string | undefined;
          reviewer?: string | undefined;
          plan?: string | undefined;
          review?: string | undefined;
        }>
      | undefined;
  }>,
): string {
  const plannerName = input.displayNames?.planner ?? input.displayNames?.plan;
  const buildName = input.displayNames?.build;
  const reviewerName = input.displayNames?.reviewer ?? input.displayNames?.review ?? plannerName;
  return formatCollapsedSeatLineFromIdentities({
    plan: formatShortSeatIdentity({ seat: input.planner, displayName: plannerName }),
    build: formatShortSeatIdentity({ seat: input.build, displayName: buildName }),
    review:
      input.reviewer === undefined
        ? null
        : formatShortSeatIdentity({ seat: input.reviewer, displayName: reviewerName }),
    budget: input.budget,
    notes: input.notes,
  });
}

/**
 * The layout half: three identities already resolved, laid out to a budget. A finished run has
 * names on record but no runner blocks, so this is the seam the summary header enters through.
 * A `null` review seat is the planner's, and says so with the inheritance mark.
 */
export function formatCollapsedSeatLineFromIdentities(
  input: Readonly<{
    plan: string;
    build: string;
    review: string | null;
    budget?: number | undefined;
    notes?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): string {
  const notes = input.notes;
  const seats: CollapsedSeat[] = [
    {
      label: CREW_SEAT_LABELS.plan,
      identity: input.plan,
      named: true,
      ...(notes?.plan !== undefined && { note: notes.plan }),
    },
    {
      label: CREW_SEAT_LABELS.build,
      identity: input.build,
      named: true,
      ...(notes?.build !== undefined && { note: notes.build }),
    },
    // The inheritance mark points at the planner's name; it is not one itself.
    {
      label: CREW_SEAT_LABELS.review,
      identity: input.review ?? PLANNER_INHERITANCE.mark,
      named: input.review !== null,
      ...(notes?.review !== undefined && { note: notes.review }),
    },
  ];
  return fitCollapsedSeats(seats, input.budget ?? Number.POSITIVE_INFINITY);
}

/**
 * Every segment is an atom: `· h…` names no effort and `· claude-sonnet…` names a model that does
 * not exist. A budget that cannot seat a whole segment
 * sheds it, tail first, down to the leading one — the same print-whole-or-drop rule the picker's
 * catalog id follows. Only the leading segment is ever cut, and when the cut ends in the ellipsis
 * the trailing separator run goes with it.
 */
export function cutSeatIdentity(identity: string, budget: number): string {
  const truncated = truncateTerminalDisplayText(shedSegments(identity, budget), budget);
  if (!truncated.endsWith(ELLIPSIS)) return truncated;
  return `${truncated.slice(0, -ELLIPSIS.length).replace(HANGING_SEPARATOR, '')}${ELLIPSIS}`;
}

function shedSegments(identity: string, budget: number): string {
  const segments = identity.split(CREW_IDENTITY_SEPARATOR);
  let kept = segments.length;
  const width = (count: number): number =>
    getTerminalCellWidth(segments.slice(0, count).join(CREW_IDENTITY_SEPARATOR));
  while (kept > 1 && width(kept) > budget) kept -= 1;
  return segments.slice(0, kept).join(CREW_IDENTITY_SEPARATOR);
}

/** A seat row cuts its full identity to the block budget; it never falls back to the short form. */
export function fitSeatIdentity(
  input: Readonly<{ runner: RunnerConfig; budget: number; displayName?: string | undefined }>,
): string {
  return cutSeatIdentity(
    formatSeatIdentity({ seat: input.runner, displayName: input.displayName }),
    input.budget,
  );
}
