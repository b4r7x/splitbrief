import {
  ELLIPSIS,
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import {
  getRunnerCatalogDisplayName,
  type RunnerConfig,
} from '../config/accessors/runner-config.js';
import { formatModelName, peelDisplayLabel } from '../model-display.js';
import { getProviderDisplayName } from '../providers/catalog.js';
import {
  AUTOMATIC_MODEL,
  isAutoCheapestModel,
  normalizeConfiguredModel,
} from '../providers/automatic-model.js';
import {
  peelAxisTokensFromModelId,
  runnerEffortChannel,
  seatAxisWords,
} from '../runners/effort-channel.js';

export const CREW_SEAT_IDS = ['plan', 'build', 'review'] as const;

export type CrewSeatId = (typeof CREW_SEAT_IDS)[number];

export const CREW_SEAT_LABELS: Readonly<Record<CrewSeatId, string>> = {
  plan: 'PLAN',
  build: 'BUILD',
  review: 'REVIEW',
};

/** Seat labels are padded to this width so every identity column starts at one offset. */
export const CREW_LABEL_WIDTH = 8;

/** `model: auto` is this word on every surface, never a resolved catalog default. */
export const AUTO_MODEL_WORD = 'auto';

/**
 * `model: auto:cheapest` is this phrase on every surface — the seat identity and the picker row
 * that sets it read the same words, so the BUILD seat is never two names for one policy.
 */
export const AUTO_CHEAPEST_MODEL_WORD = 'Auto (cheapest capable)';

export const PLANNER_INHERITANCE = Object.freeze({
  sentence: 'same as planner',
  mark: '= planner',
});

/** The one middle dot that joins the parts of every crew identity, on the row and in the fold marker. */
export const CREW_IDENTITY_SEPARATOR = ' · ';
const CLAUDE_BRAND = 'Claude';
const HANGING_SEPARATOR = /[ ·]+$/u;

function modelWord(runner: RunnerConfig, displayName?: string | undefined): string {
  const configured = 'model' in runner ? runner.model : undefined;
  const model = normalizeConfiguredModel(
    configured,
    runner.kind === 'cli' ? runner.tool : undefined,
  );
  if (model === undefined || model === AUTOMATIC_MODEL) return AUTO_MODEL_WORD;
  if (isAutoCheapestModel(model)) return AUTO_CHEAPEST_MODEL_WORD;
  if (runnerEffortChannel(runner) === 'model-id') {
    const peeled = displayName ? peelDisplayLabel(displayName) : '';
    if (peeled !== '') return peeled;
    return formatModelName(peelAxisTokensFromModelId(model));
  }
  if (displayName) return displayName;
  return formatModelName(model);
}

export function formatSeatIdentity(runner: RunnerConfig, displayName?: string | undefined): string {
  return sanitizeTerminalDisplayText(
    [
      getRunnerCatalogDisplayName(runner),
      modelWord(runner, displayName),
      ...seatAxisWords(runner),
    ].join(CREW_IDENTITY_SEPARATOR),
  );
}

/** The collapsed form: the brand is implied by the seat, so it is the one word dropped. */
export function formatShortSeatIdentity(
  runner: RunnerConfig,
  displayName?: string | undefined,
): string {
  const words = sanitizeTerminalDisplayText(modelWord(runner, displayName))
    .split(' ')
    .filter(Boolean);
  const stripped = words[0] === CLAUDE_BRAND ? words.slice(1) : words;
  const rest = stripped.length === 0 ? words : stripped;
  return rest.join(' ');
}

/**
 * A tool this seat could move to, named before it is configured: the same
 * `<tool> · <model>` shape a configured seat shows, composed from ids alone
 * because a swap candidate is two strings, not a runner block. A candidate
 * that names no model is the tool's own default and says only the tool.
 */
export function formatSeatCandidateIdentity(
  candidate: Readonly<{ tool: string; model?: string | undefined }>,
): string {
  const words = [getProviderDisplayName(candidate.tool)];
  if (candidate.model !== undefined) words.push(formatModelName(candidate.model));
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

function collapsedSeatLine(seats: readonly CollapsedSeat[], elided: ReadonlySet<number>): string {
  return seats
    .map((seat, index) =>
      collapsedSeatText(elided.has(index) ? { ...seat, identity: ELLIPSIS } : seat),
    )
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
  const review =
    input.reviewer === undefined
      ? PLANNER_INHERITANCE.mark
      : formatShortSeatIdentity(input.reviewer, reviewerName);
  const notes = input.notes;
  const seats: CollapsedSeat[] = [
    {
      label: CREW_SEAT_LABELS.plan,
      identity: formatShortSeatIdentity(input.planner, plannerName),
      named: true,
      ...(notes?.plan !== undefined && { note: notes.plan }),
    },
    {
      label: CREW_SEAT_LABELS.build,
      identity: formatShortSeatIdentity(input.build, buildName),
      named: true,
      ...(notes?.build !== undefined && { note: notes.build }),
    },
    // The inheritance mark points at the planner's name; it is not one itself.
    {
      label: CREW_SEAT_LABELS.review,
      identity: review,
      named: input.reviewer !== undefined,
      ...(notes?.review !== undefined && { note: notes.review }),
    },
  ];
  return fitCollapsedSeats(seats, input.budget ?? Number.POSITIVE_INFINITY);
}

/**
 * Every segment is an atom: `· h…` names no effort, `· claude-sonnet…` names a model that does not
 * exist, and `Auto (cheapest capa…` names no policy. A budget that cannot seat a whole segment
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
  return cutSeatIdentity(formatSeatIdentity(input.runner, input.displayName), input.budget);
}
