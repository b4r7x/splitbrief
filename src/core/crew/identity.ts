import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import {
  getRunnerCatalogDisplayName,
  type RunnerConfig,
} from '../config/accessors/runner-config.js';
import { formatModelName } from '../model-display.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../providers/automatic-model.js';

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

function modelWord(runner: RunnerConfig): string {
  const configured = 'model' in runner ? runner.model : undefined;
  const model = normalizeConfiguredModel(
    configured,
    runner.kind === 'cli' ? runner.tool : undefined,
  );
  if (model === undefined || model === AUTOMATIC_MODEL) return AUTO_MODEL_WORD;
  return formatModelName(model);
}

export function formatSeatIdentity(runner: RunnerConfig): string {
  return sanitizeTerminalDisplayText(
    `${getRunnerCatalogDisplayName(runner)}${CREW_IDENTITY_SEPARATOR}${modelWord(runner)}`,
  );
}

/** The collapsed form: the brand is implied by the seat, so only the distinguishing words survive. */
export function formatShortSeatIdentity(runner: RunnerConfig): string {
  const words = sanitizeTerminalDisplayText(modelWord(runner)).split(' ').filter(Boolean);
  const stripped = words[0] === CLAUDE_BRAND ? words.slice(1) : words;
  const rest = stripped.length === 0 ? words : stripped;
  const kept = rest.length > 2 ? [...rest.slice(0, 1), ...rest.slice(-1)] : rest;
  return kept.join(' ');
}

export function formatInheritedIdentity(planner: RunnerConfig): string {
  return `${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${formatSeatIdentity(planner)}`;
}

export function formatCollapsedSeatLine(
  input: Readonly<{
    planner: RunnerConfig;
    build: RunnerConfig;
    reviewer: RunnerConfig | undefined;
  }>,
): string {
  const review =
    input.reviewer === undefined
      ? PLANNER_INHERITANCE.short
      : formatShortSeatIdentity(input.reviewer);
  return [
    `${CREW_SEAT_LABELS.plan} ${formatShortSeatIdentity(input.planner)}`,
    `${CREW_SEAT_LABELS.build} ${formatShortSeatIdentity(input.build)}`,
    `${CREW_SEAT_LABELS.review} ${review}`,
  ].join(CREW_IDENTITY_SEPARATOR);
}

/** A seat row cuts its full identity to the block budget; it never falls back to the short form. */
export function fitSeatIdentity(input: Readonly<{ runner: RunnerConfig; budget: number }>): string {
  return truncateWithEllipsis(formatSeatIdentity(input.runner), input.budget);
}
