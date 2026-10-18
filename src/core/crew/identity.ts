import {
  ELLIPSIS,
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { redactSecrets } from '../../utils/redact.js';
import {
  getRunnerDisplayName,
  type RunnerConfig,
  type RunnerConfigSlot,
} from '../config/accessors/runner-config.js';
import { cliVocabularyTool, formatModelName, peelDisplayLabel } from '../model-display.js';
import { getRunnerIdentityDisplayName } from '../providers/catalog.js';
import {
  AUTOMATIC_MODEL,
  normalizeConfiguredModel,
  resolveCliModel,
} from '../providers/automatic-model.js';
import type { EffortLevel, RunnerKind } from '../schemas/enums.js';
import { PICKER_ROLE_SEAT_IDS, type ActiveRunnerRole } from '../runners/seat-roles.js';
import { SOFT_SEP } from '../separators.js';
import { CLI_TOOL_CATALOG, isCliToolId } from '../runners/cli-tool-catalog.js';
import {
  peelAxisTokensFromModelId,
  recordedAxisWords,
  seatAxisWords,
} from '../runners/effort-channel.js';

export const CREW_SEAT_IDS = ['plan', 'build', 'review'] as const;

export type CrewSeatId = (typeof CREW_SEAT_IDS)[number];

/** The catalog label a seat's model goes by; undefined where no catalog names it. */
export type SeatDisplayName = (runner: RunnerConfig, role: ActiveRunnerRole) => string | undefined;

export const CREW_SEAT_LABELS: Readonly<Record<CrewSeatId, string>> = {
  plan: 'PLAN',
  build: 'BUILD',
  review: 'REVIEW',
};

/** The seat word for a runner slot; a BUILD profile beside the implementer block adds its name. */
export function formatSlotLabel(slot: RunnerConfigSlot): string {
  const label = CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[slot.role]];
  return slot.role === 'implementer' && slot.profile !== 'default'
    ? `${label} (${slot.profile})`
    : label;
}

/** Seat labels are padded to this width so every identity column starts at one offset. */
export const CREW_LABEL_WIDTH = 8;

/** `model: auto` stays this word on the configuration surfaces; a run's own record names the model the tool selected. */
export const AUTO_MODEL_WORD = 'auto';

export const PLANNER_INHERITANCE = Object.freeze({
  mark: '= PLAN',
});

/** The one middle dot that joins the parts of every crew identity, on the row and in the fold marker. */
export const CREW_IDENTITY_SEPARATOR = SOFT_SEP;
const CLAUDE_BRAND = 'Claude';
const HANGING_SEPARATOR = /[ ·]+$/u;

/**
 * A seat named by ids rather than by its runner block: the tool or provider word,
 * the configured model, the axis words the seat
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

export function isSeatIdentity(
  seat: Readonly<{ tool: string; model?: string | undefined }>,
  candidate: Readonly<{ tool: string; model?: string | undefined }>,
): boolean {
  if (candidate.tool !== seat.tool) return false;
  const model = resolveCliModel(candidate.model, candidate.tool);
  return model === undefined || model === resolveCliModel(seat.model, seat.tool);
}

function recordedAxes(seat: SeatIds, kind: RunnerKind | undefined): readonly string[] {
  const tool = cliVocabularyTool(seat.tool, kind);
  const axes = seat.axes ?? [];
  return tool === undefined ? axes : recordedAxisWords(tool, seat.model, axes);
}

/**
 * Two recorded seats are the same seat when their ids match: a catalog that renames the model
 * changes the identity, not the seat. The axes compare by the level that runs, so a record
 * that left out the level its id spells still matches. A side recorded before kinds were kept
 * matches any kind.
 */
export function sameSeatIds(left: SeatIds, right: SeatIds): boolean {
  return (
    left.tool === right.tool &&
    resolveCliModel(left.model, left.tool) === resolveCliModel(right.model, right.tool) &&
    recordedAxes(left, left.kind).join(' ') === recordedAxes(right, right.kind).join(' ') &&
    (left.kind === undefined || right.kind === undefined || left.kind === right.kind)
  );
}

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
 * name even when it reuses a CLI tool id; a CLI command names its tool,
 * and shell and agent commands stay literal unless they name their canonical seat id.
 */
function toolWord(seat: SeatIds, kind: RunnerKind | undefined): string {
  return getRunnerIdentityDisplayName(kind, seat.tool);
}

function modelIdOf(seat: SeatIds, kind: RunnerKind | undefined): string | undefined {
  const tool = cliVocabularyTool(seat.tool, kind);
  const model = normalizeConfiguredModel(seat.model, tool);
  return model !== undefined &&
    tool !== undefined &&
    CLI_TOOL_CATALOG[tool].effortChannel === 'model-id'
    ? peelAxisTokensFromModelId(model)
    : model;
}

function modelName(
  seat: SeatIds,
  displayName: string | undefined,
  kind: RunnerKind | undefined,
): string {
  const tool = cliVocabularyTool(seat.tool, kind);
  const model = modelIdOf(seat, kind);
  if (model === undefined || model === AUTOMATIC_MODEL) return AUTO_MODEL_WORD;
  if (tool !== undefined && CLI_TOOL_CATALOG[tool].effortChannel === 'model-id') {
    const peeled = displayName ? peelDisplayLabel(displayName) : '';
    if (peeled !== '') return peeled;
    return formatModelName(model, tool);
  }
  return displayName || formatModelName(model, tool);
}

/** The provider an OpenCode route runs through, as `via <provider>`; two routes of one model differ only here. */
function providerWord(seat: SeatIds, kind: RunnerKind | undefined): string | undefined {
  const model = redactSecrets(sanitizeTerminalDisplayText(modelIdOf(seat, kind) ?? ''));
  return cliVocabularyTool(seat.tool, kind) === 'opencode' && model.includes('/')
    ? `via ${model.slice(0, model.indexOf('/'))}`
    : undefined;
}

function modelWord(
  seat: SeatIds,
  displayName: string | undefined,
  kind: RunnerKind | undefined,
): string {
  const provider = providerWord(seat, kind);
  const name = modelName(seat, displayName, kind);
  return provider === undefined ? name : [name, provider].join(CREW_IDENTITY_SEPARATOR);
}

function formatIdentity(
  ids: SeatIds,
  model: string | undefined,
  kind: RunnerKind | undefined,
): string {
  return sanitizeTerminalDisplayText(
    [toolWord(ids, kind), ...(model === undefined ? [] : [model]), ...recordedAxes(ids, kind)].join(
      CREW_IDENTITY_SEPARATOR,
    ),
  );
}

export function formatSeatIdentity(input: {
  seat: RunnerConfig | SeatIds;
  displayName?: string | undefined;
  kind?: RunnerKind | undefined;
}): string {
  const { seat, displayName, kind } = input;
  const ids = idsOf(seat);
  const resolvedKind = kind ?? runnerKindOf(seat);
  return formatIdentity(ids, modelWord(ids, displayName, resolvedKind), resolvedKind);
}

export function formatSeatChangeIdentities(
  from: Parameters<typeof formatSeatIdentity>[0] | SeatCandidateAxes,
  to: Parameters<typeof formatSeatIdentity>[0] | SeatCandidateAxes,
): Readonly<{ from: string; to: string }> {
  const fromInput: Parameters<typeof formatSeatIdentity>[0] =
    'seat' in from ? from : { seat: candidateIdsOf(from) };
  const toInput: Parameters<typeof formatSeatIdentity>[0] =
    'seat' in to ? to : { seat: candidateIdsOf(to) };
  const fromIds = idsOf(fromInput.seat);
  const toIds = idsOf(toInput.seat);
  const fromKind = fromInput.kind ?? runnerKindOf(fromInput.seat);
  const toKind = toInput.kind ?? runnerKindOf(toInput.seat);
  const fromWord =
    !('seat' in from) && from.model === undefined
      ? undefined
      : modelWord(fromIds, fromInput.displayName, fromKind);
  const toWord =
    !('seat' in to) && to.model === undefined
      ? undefined
      : modelWord(toIds, toInput.displayName, toKind);
  const useModelIds =
    modelIdOf(fromIds, fromKind) !== modelIdOf(toIds, toKind) &&
    sanitizeTerminalDisplayText(fromWord ?? '') === sanitizeTerminalDisplayText(toWord ?? '');
  return {
    from: formatIdentity(
      fromIds,
      useModelIds ? (fromIds.model ?? AUTO_MODEL_WORD) : fromWord,
      fromKind,
    ),
    to: formatIdentity(toIds, useModelIds ? (toIds.model ?? AUTO_MODEL_WORD) : toWord, toKind),
  };
}

/**
 * The collapsed form names the model without its brand or axes. An OpenCode route keeps its
 * provider, joined by a space because the middle dot already parts the seats on the line.
 */
export function formatShortSeatIdentity(input: {
  seat: RunnerConfig | SeatIds;
  displayName?: string | undefined;
  kind?: RunnerKind | undefined;
}): string {
  const { seat, displayName } = input;
  const ids = idsOf(seat);
  const kind = input.kind ?? runnerKindOf(seat);
  const words = sanitizeTerminalDisplayText(modelName(ids, displayName, kind))
    .split(' ')
    .filter(Boolean);
  const stripped = words[0] === CLAUDE_BRAND ? words.slice(1) : words;
  const rest = stripped.length === 0 ? words : stripped;
  const provider = providerWord(ids, kind);
  return [...rest, ...(provider === undefined ? [] : [provider])].join(' ');
}

type SeatCandidateAxes = Readonly<{
  tool: string;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  variant?: string | undefined;
}>;

/** Two swap candidates name the same seat when tool, model, effort and variant all match. */
export function sameSeatCandidate(left: SeatCandidateAxes, right: SeatCandidateAxes): boolean {
  return (
    left.tool === right.tool &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.variant === right.variant
  );
}

export function candidateIdsOf(candidate: SeatCandidateAxes): SeatIds {
  const tool = cliVocabularyTool(candidate.tool, undefined);
  return {
    tool: candidate.tool,
    model: candidate.model,
    axes:
      tool === undefined || candidate.model === undefined
        ? []
        : seatAxisWords({
            kind: 'cli',
            tool,
            model: candidate.model,
            effort: candidate.effort,
            variant: candidate.variant,
          }),
    kind: tool === undefined ? undefined : 'cli',
  };
}

/**
 * A tool this seat could move to, named before it is configured: the same
 * `<tool> · <model>` shape a configured seat shows, composed from ids and the
 * model's catalog label because a swap candidate is two strings, not a runner
 * block. A candidate that names no model is the tool's own default and says
 * only the tool. Model words and axes follow the configured seat's rules.
 */
export function formatSeatCandidateIdentity(
  candidate: SeatCandidateAxes,
  displayName?: string | undefined,
): string {
  const ids = candidateIdsOf(candidate);
  return formatIdentity(
    ids,
    candidate.model === undefined ? undefined : modelWord(ids, displayName, ids.kind),
    ids.kind,
  );
}

export type SeatLineSpan = Readonly<{ text: string; seat?: CrewSeatId }>;

type CollapsedSeat = Readonly<{
  id: CrewSeatId;
  identity: string;
  named: boolean;
  /** A condition the seat carries while it lasts, parenthesized so it binds to this seat and not the next. */
  note?: string | undefined;
}>;

function collapsedSeatText(seat: CollapsedSeat): SeatLineSpan {
  const label = CREW_SEAT_LABELS[seat.id];
  const text =
    seat.note === undefined
      ? `${label} ${seat.identity}`
      : `${label} ${seat.identity} (${seat.note})`;
  return { text, seat: seat.id };
}

export function seatLineText(spans: readonly SeatLineSpan[]): string {
  return spans.map((span) => span.text).join('');
}

// An elided seat leaves the line entirely. `REVIEW …` names no seat and reads as "pending" beside
// the workflow rail, so the seats that still fit are stated and the rest are silent.
function collapsedSeatLine(
  seats: readonly Readonly<{ span: SeatLineSpan }>[],
  elided: ReadonlySet<number>,
): SeatLineSpan[] {
  const spans: SeatLineSpan[] = [];
  for (const [index, seat] of seats.entries()) {
    if (elided.has(index)) continue;
    if (spans.length > 0) spans.push({ text: CREW_IDENTITY_SEPARATOR });
    spans.push(seat.span);
  }
  return spans;
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
function elideCollapsedSeats(
  seats: readonly (CollapsedSeat & Readonly<{ span: SeatLineSpan }>)[],
  budget: number,
  haltedSeat?: CrewSeatId,
): SeatLineSpan[] {
  const lastFirst = seats
    .map((seat, index) => ({ index, width: getTerminalCellWidth(seat.identity) }))
    .reverse();
  const elided = new Set<number>();
  const width = (omitted: ReadonlySet<number>): number =>
    getTerminalCellWidth(seatLineText(collapsedSeatLine(seats, omitted)));
  const fitsWithout = (index: number): boolean => width(new Set([...elided, index])) <= budget;
  while (elided.size < seats.length && width(elided) > budget) {
    const remaining = lastFirst.filter((seat) => !elided.has(seat.index));
    const pool = remaining.filter(
      (seat) => seats[seat.index]?.note === undefined && seats[seat.index]?.id !== haltedSeat,
    );
    if (pool.length === 0) return [];
    // When no single name is enough, the widest goes and the line is measured
    // again, so the line never hides more names than it has to.
    const chosen =
      pool.find((seat) => fitsWithout(seat.index)) ??
      pool.reduce((widest, seat) => (seat.width > widest.width ? seat : widest));
    elided.add(chosen.index);
  }
  const namesSomeone = seats.some((seat, index) => seat.named && !elided.has(index));
  return namesSomeone ? collapsedSeatLine(seats, elided) : [];
}

/**
 * A note outranks the names of the seats it does not belong to: it says what is
 * happening right now, and the elision rule already spends those names to buy
 * room. What it never outranks is its own seat's name — a clock beside `BUILD …`
 * names no seat — so a budget that cannot seat the noted name drops every note
 * and lays the plain line out. The halted seat stays protected while the plain line names a seat.
 */
function fitCollapsedSeats(
  seats: readonly CollapsedSeat[],
  budget: number,
  haltedSeat?: CrewSeatId,
): SeatLineSpan[] {
  const notedSeats = seats.map((seat) => ({ ...seat, span: collapsedSeatText(seat) }));
  const plainSeats = notedSeats.map((seat) => {
    if (seat.note === undefined) return seat;
    const plain = { id: seat.id, identity: seat.identity, named: seat.named };
    return { ...plain, span: collapsedSeatText(plain) };
  });
  const protectedSeat =
    haltedSeat !== undefined && elideCollapsedSeats(plainSeats, budget, haltedSeat).length > 0
      ? haltedSeat
      : undefined;
  const noted = elideCollapsedSeats(notedSeats, budget, protectedSeat);
  if (seats.every((seat) => seat.note === undefined)) return noted;
  if (noted.length > 0 && getTerminalCellWidth(seatLineText(noted)) <= budget) return noted;
  return elideCollapsedSeats(plainSeats, budget, protectedSeat);
}

export function formatCollapsedSeatSpans(
  input: Readonly<{
    planner: RunnerConfig;
    build: RunnerConfig;
    reviewer: RunnerConfig | undefined;
    budget?: number | undefined;
    haltedSeat?: CrewSeatId | undefined;
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
): SeatLineSpan[] {
  const plannerName = input.displayNames?.planner ?? input.displayNames?.plan;
  const buildName = input.displayNames?.build;
  const reviewerName = input.displayNames?.reviewer ?? input.displayNames?.review ?? plannerName;
  return formatCollapsedSeatSpansFromIdentities({
    plan: formatShortSeatIdentity({ seat: input.planner, displayName: plannerName }),
    build: formatShortSeatIdentity({ seat: input.build, displayName: buildName }),
    review:
      input.reviewer === undefined
        ? null
        : formatShortSeatIdentity({ seat: input.reviewer, displayName: reviewerName }),
    budget: input.budget,
    haltedSeat: input.haltedSeat,
    notes: input.notes,
  });
}

/**
 * The layout half: three identities already resolved, laid out to a budget. A finished run has
 * names on record but no runner blocks, so this is the seam the summary header enters through.
 * A `null` review seat is the planner's, and says so with the inheritance mark.
 */
export function formatCollapsedSeatSpansFromIdentities(
  input: Readonly<{
    plan: string;
    build: string;
    review: string | null;
    budget?: number | undefined;
    haltedSeat?: CrewSeatId | undefined;
    notes?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): SeatLineSpan[] {
  const notes = input.notes;
  const seats: CollapsedSeat[] = [
    {
      id: 'plan',
      identity: input.plan,
      named: true,
      ...(notes?.plan !== undefined && { note: notes.plan }),
    },
    {
      id: 'build',
      identity: input.build,
      named: true,
      ...(notes?.build !== undefined && { note: notes.build }),
    },
    // The inheritance mark points at the planner's name; it is not one itself.
    {
      id: 'review',
      identity: input.review ?? PLANNER_INHERITANCE.mark,
      named: input.review !== null,
      ...(notes?.review !== undefined && { note: notes.review }),
    },
  ];
  return fitCollapsedSeats(seats, input.budget ?? Number.POSITIVE_INFINITY, input.haltedSeat);
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

export function wrapSeatIdentity(identity: string, budget: number): string[] {
  if (getTerminalCellWidth(identity) <= budget) return [identity];
  const segments = identity.split(CREW_IDENTITY_SEPARATOR);
  const providerIndex = opencodeProviderIndex(segments);
  if (
    providerIndex !== undefined &&
    getTerminalCellWidth(segments.slice(providerIndex - 1).join(CREW_IDENTITY_SEPARATOR)) > budget
  ) {
    const fits = (row: readonly string[]): boolean =>
      getTerminalCellWidth(row.join(CREW_IDENTITY_SEPARATOR)) <= budget;
    const modelAndProvider = segments.slice(providerIndex - 1, providerIndex + 1);
    const toolAndModel = segments.slice(0, providerIndex);
    const providerAndAxes = segments.slice(providerIndex);
    return (
      fits(modelAndProvider)
        ? [
            [...segments.slice(0, providerIndex - 1), ...segments.slice(providerIndex + 1)],
            modelAndProvider,
          ]
        : fits(toolAndModel)
          ? [toolAndModel, providerAndAxes]
          : [toolAndModel.slice(0, -1), toolAndModel.slice(-1), providerAndAxes]
    ).map((row) => cutSeatIdentity(row.join(CREW_IDENTITY_SEPARATOR), budget));
  }
  return [
    segments.slice(0, 1).join(CREW_IDENTITY_SEPARATOR),
    segments.slice(1).join(CREW_IDENTITY_SEPARATOR),
  ].map((row) => cutSeatIdentity(row, budget));
}

function opencodeProviderIndex(segments: readonly string[]): number | undefined {
  const toolIndex = segments.indexOf(toolWord({ tool: 'opencode' }, 'cli'));
  const providerIndex = toolIndex + 2;
  return toolIndex >= 0 && segments[providerIndex]?.startsWith('via ') ? providerIndex : undefined;
}

function shedSegments(identity: string, budget: number): string {
  const segments = identity.split(CREW_IDENTITY_SEPARATOR);
  const width = (count: number): number =>
    getTerminalCellWidth(segments.slice(0, count).join(CREW_IDENTITY_SEPARATOR));
  const providerIndex = opencodeProviderIndex(segments);
  const keepModel = providerIndex !== undefined && width(providerIndex + 1) > budget;
  if (keepModel) segments.splice(providerIndex - 2, 1);
  const minimum = keepModel ? providerIndex - 1 : 1;
  let kept = segments.length;
  while (kept > minimum && width(kept) > budget) kept -= 1;
  return segments.slice(0, kept).join(CREW_IDENTITY_SEPARATOR);
}
