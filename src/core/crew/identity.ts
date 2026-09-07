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
import { formatModelName } from '../model-display.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../providers/automatic-model.js';
import {
  optionTokensOfModelId,
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

export const PLANNER_INHERITANCE = Object.freeze({
  sentence: 'same as planner',
  mark: '= planner',
  short: '= plan',
});

/** The one middle dot that joins the parts of every crew identity, on the row and in the fold marker. */
export const CREW_IDENTITY_SEPARATOR = ' · ';
const CLAUDE_BRAND = 'Claude';

function modelWord(runner: RunnerConfig, displayName?: string | undefined): string {
  const configured = 'model' in runner ? runner.model : undefined;
  const model = normalizeConfiguredModel(
    configured,
    runner.kind === 'cli' ? runner.tool : undefined,
  );
  if (model === undefined || model === AUTOMATIC_MODEL) return AUTO_MODEL_WORD;
  if (runnerEffortChannel(runner) === 'model-id' && optionTokensOfModelId(model).length > 0) {
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

export function formatInheritedIdentity(
  planner: RunnerConfig,
  plannerDisplayName?: string | undefined,
): string {
  return `${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${formatSeatIdentity(planner, plannerDisplayName)}`;
}

type CollapsedSeat = Readonly<{ label: string; identity: string; named: boolean }>;

function collapsedSeatLine(seats: readonly CollapsedSeat[], elided: ReadonlySet<number>): string {
  return seats
    .map((seat, index) =>
      elided.has(index) ? `${seat.label} ${ELLIPSIS}` : `${seat.label} ${seat.identity}`,
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
function fitCollapsedSeats(seats: readonly CollapsedSeat[], budget: number): string {
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
    // When no single name is enough, the widest goes and the line is measured
    // again, so the line never hides more names than it has to.
    const chosen =
      remaining.find((seat) => fitsWithout(seat.index)) ??
      remaining.reduce((widest, seat) => (seat.width > widest.width ? seat : widest));
    elided.add(chosen.index);
  }
  const namesSomeone = seats.some((seat, index) => seat.named && !elided.has(index));
  return namesSomeone ? collapsedSeatLine(seats, elided) : '';
}

export function formatCollapsedSeatLine(
  input: Readonly<{
    planner: RunnerConfig;
    build: RunnerConfig;
    reviewer: RunnerConfig | undefined;
    budget?: number | undefined;
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
      ? PLANNER_INHERITANCE.short
      : formatShortSeatIdentity(input.reviewer, reviewerName);
  const seats = [
    {
      label: CREW_SEAT_LABELS.plan,
      identity: formatShortSeatIdentity(input.planner, plannerName),
      named: true,
    },
    {
      label: CREW_SEAT_LABELS.build,
      identity: formatShortSeatIdentity(input.build, buildName),
      named: true,
    },
    // The inheritance mark points at the planner's name; it is not one itself.
    { label: CREW_SEAT_LABELS.review, identity: review, named: input.reviewer !== undefined },
  ];
  return fitCollapsedSeats(seats, input.budget ?? Number.POSITIVE_INFINITY);
}

/** A seat row cuts its full identity to the block budget; it never falls back to the short form. */
export function fitSeatIdentity(
  input: Readonly<{ runner: RunnerConfig; budget: number; displayName?: string | undefined }>,
): string {
  return truncateTerminalDisplayText(
    formatSeatIdentity(input.runner, input.displayName),
    input.budget,
  );
}
