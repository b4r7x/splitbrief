import { assertNever } from '../../utils/type-guards.js';
import type { ActiveRunnerRole } from './seat-roles.js';
import { CLI_TOOL_CATALOG, isCliToolId } from './cli-tool-catalog.js';
import { type CliEffortChannel, runnerEffortChannel } from './effort-channel.js';
import type { ProviderDetection } from '../discovery/detection.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { resolveAutoModel } from '../providers/model-selection.js';

/** The models.dev fact for one model; absent when detection never reached it. */
export type DetectedModelFact = Readonly<{ supportsImages?: boolean }>;

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
