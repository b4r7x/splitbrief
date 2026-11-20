import { sanitizeTerminalDisplayText } from '../../utils/display-text/sanitize.js';
import { redactSecrets } from '../../utils/redact/secrets.js';
import type { RunnerConfig, RunnerConfigSlot } from '../config/accessors/runner-config.js';
import {
  cliVocabularyTool,
  formatModelName,
  peelDisplayLabel,
} from '../providers/model-display.js';
import { getRunnerIdentityDisplayName } from '../providers/catalog.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../providers/automatic-model.js';
import type { EffortLevel, RunnerKind } from '../schemas/enums.js';
import { PICKER_ROLE_SEAT_IDS, type ActiveRunnerRole } from '../runners/seat-roles.js';
import { SOFT_SEP } from '../separators.js';
import { CLI_TOOL_CATALOG } from '../runners/cli-tool/catalog.js';
import type { CliToolId } from '../runners/cli-tool/types.js';
import { modelProviderAuthKey } from '../runners/route-auth.js';
import { peelAxisTokensFromModelId, seatAxisWords } from '../runners/effort-channel.js';
import { type SeatIds, recordedAxes, idsOf } from './seat-ids.js';

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

export const REVIEW_NONE = Object.freeze({
  mark: 'None',
});

export function isReviewNone(seat: object | undefined): seat is typeof REVIEW_NONE {
  return seat === REVIEW_NONE;
}

/** The one middle dot that joins the parts of every crew identity, on the row and in the fold marker. */
export const CREW_IDENTITY_SEPARATOR = SOFT_SEP;
const CLAUDE_BRAND = 'Claude';
export const HANGING_SEPARATOR = /[ ·]+$/u;

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
export function toolWord(seat: SeatIds, kind: RunnerKind | undefined): string {
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

/** A tool whose models are `<provider>/<model>` routes, signed in and billed per provider. */
export function routesByProvider(tool: CliToolId | undefined): boolean {
  return tool !== undefined && CLI_TOOL_CATALOG[tool].auth.kind === 'provider-dependent';
}

/**
 * The provider a route runs through, as `via <provider>`, the key the picker's route row and the
 * sign-in state name; two routes of one model differ only here.
 */
function providerWord(seat: SeatIds, kind: RunnerKind | undefined): string | undefined {
  if (!routesByProvider(cliVocabularyTool(seat.tool, kind))) return undefined;
  const provider = modelProviderAuthKey(
    redactSecrets(sanitizeTerminalDisplayText(modelIdOf(seat, kind) ?? '')),
  );
  return provider === undefined ? undefined : `via ${provider}`;
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
 * The collapsed form names the model without its brand or axes. A provider route keeps its
 * provider, joined by a space because the middle dot already parts the seats on the line.
 * An automatic model names no seat, so the form names the tool of the long form instead.
 */
export function formatShortSeatIdentity(input: {
  seat: RunnerConfig | SeatIds;
  displayName?: string | undefined;
  kind?: RunnerKind | undefined;
}): string {
  const { seat, displayName } = input;
  const ids = idsOf(seat);
  const kind = input.kind ?? runnerKindOf(seat);
  const model = modelIdOf(ids, kind);
  if (model === undefined || model === AUTOMATIC_MODEL) {
    return sanitizeTerminalDisplayText(toolWord(ids, kind));
  }
  const words = sanitizeTerminalDisplayText(modelName(ids, displayName, kind))
    .split(' ')
    .filter(Boolean);
  const stripped = words[0] === CLAUDE_BRAND ? words.slice(1) : words;
  const rest = stripped.length === 0 ? words : stripped;
  const provider = providerWord(ids, kind);
  return [...rest, ...(provider === undefined ? [] : [provider])].join(' ');
}

/**
 * The tool a seat runs on, in the one word a narrow crew line has room for: a catalogued CLI
 * uses the shorter of its command and tool ID. An uncatalogued CLI keeps its configured name.
 * An API seat names its provider, and a command runner names its kind.
 */
export function formatSeatToolWord(input: {
  seat: RunnerConfig | SeatIds;
  kind?: RunnerKind | undefined;
}): string {
  const ids = idsOf(input.seat);
  const kind = input.kind ?? runnerKindOf(input.seat);
  if (kind === 'shell') return 'shell';
  if (kind === 'agent') return 'agent';
  const tool = cliVocabularyTool(ids.tool, kind);
  if (tool === undefined) return sanitizeTerminalDisplayText(ids.tool);
  const { command } = CLI_TOOL_CATALOG[tool];
  return tool.length < command.length ? tool : command;
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
