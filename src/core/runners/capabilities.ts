import { assertNever } from '../../utils/type-guards.js';
import type { ActiveRunnerRole } from './seat-roles.js';
import { CLI_TOOL_CATALOG, isCliToolId } from './cli-tool-catalog.js';
import { type CliEffortChannel, runnerEffortChannel } from './effort-channel.js';
import type { ProviderDetection } from '../discovery/detection.js';
import {
  getRunnerCatalogDisplayName,
  type RunnerConfig,
} from '../config/accessors/runner-config.js';
import { resolveAutoModel } from '../providers/model-selection.js';
import type { Config } from '../schemas/config.js';
import { pluralize } from '../../utils/pluralize.js';

/** The models.dev fact for one model; absent when detection never reached it. */
export type DetectedModelFact = Readonly<{ supportsImages?: boolean }>;

/** The detected image fact of a seat's model; undefined where no lookup knows it. */
export type SeatImageFact = (
  runner: RunnerConfig,
  role: ActiveRunnerRole,
) => DetectedModelFact | undefined;

export function seatEffortChannel(
  input: Readonly<{ runner: RunnerConfig; role: ActiveRunnerRole }>,
): CliEffortChannel {
  return runnerEffortChannel(input.runner);
}

/** The level the seat already runs, read from the field its own channel spends. */
export function seatConfiguredEffort(
  input: Readonly<{ runner: RunnerConfig; role: ActiveRunnerRole }>,
): string | null {
  const channel = seatEffortChannel(input);
  if (channel === 'effort-flag') return input.runner.effort ?? null;
  if (channel === 'variant') return input.runner.variant ?? null;
  return null;
}

/**
 * The seat's image fact: a CLI takes images only when its tool declares a
 * channel for them; an API seat follows the models.dev modality detection.
 */
export function seatSupportsImages(
  input: Readonly<{ runner: RunnerConfig; detected?: DetectedModelFact | undefined }>,
): boolean {
  const runner = input.runner;
  switch (runner.kind) {
    case 'cli':
      return isCliToolId(runner.tool) && CLI_TOOL_CATALOG[runner.tool].imageInput !== 'none';
    case 'api':
      return input.detected?.supportsImages ?? false;
    case 'shell':
    case 'agent':
      return false;
    default:
      return assertNever(runner);
  }
}

/** The step that changes a review seat with no image input during a run. */
export const REVIEW_SEAT_IMAGE_FIX =
  'Change the review seat to a tool that reads images with /crew review';

/**
 * The note that the review seat cannot see the renders. It names the render checks, or render
 * checks in general when no plan names them.
 */
export function reviewSeatRenderNote(
  input: Readonly<{ runner: RunnerConfig; renderCheckIds: readonly string[] }>,
): string {
  const ids = input.renderCheckIds;
  const checks =
    ids.length === 0
      ? 'render checks'
      : `${pluralize(ids.length, 'render check')} ${ids.join(', ')}`;
  return `The review seat, ${getRunnerCatalogDisplayName(input.runner)}, cannot see images. The criteria of ${checks} cannot pass with this seat.`;
}

/**
 * Whether a review seat reads the change from a file in its workspace. A CLI tool reads files
 * there; an API seat reads none, and a shell or agent command may hand the prompt to a model
 * that cannot, so each of those takes the change in its prompt.
 */
export function seatReadsChangeFile(runner: RunnerConfig): boolean {
  return runner.kind === 'cli';
}

export function plannerSupportsImages(
  config: Config | null,
  providers: readonly ProviderDetection[],
): boolean {
  if (config === null) return false;
  return seatSupportsImages({
    runner: config.planner,
    detected: detectedModelFact(providers, config.planner),
  });
}

/** The detected fact for the seat's own model, when the seat runs an API provider. */
export function detectedModelFact(
  providers: readonly ProviderDetection[],
  runner: RunnerConfig,
): DetectedModelFact | undefined {
  if (runner.kind !== 'api') return undefined;
  const detection = providers.find((provider) => provider.provider === runner.provider);
  const resolved = resolveAutoModel(runner.model, runner.provider);
  const model = detection?.models?.find((candidate) => candidate.id === resolved);
  if (model === undefined) return undefined;
  return model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages };
}
