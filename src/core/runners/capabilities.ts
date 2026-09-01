import { assertNever } from '../../utils/type-guards.js';
import { CLI_TOOL_CATALOG } from './cli-tool-catalog.js';
import type { ActiveRunnerRole } from './seat-roles.js';
import type { CliEffortChannel } from './effort-channel.js';
import type { ProviderDetection } from '../discovery/detection.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { resolveAutoModel } from '../providers/model-selection.js';

/** The models.dev fact for one model; absent when detection never reached it. */
export type DetectedModelFact = Readonly<{ supportsImages?: boolean }>;

export function seatEffortChannel(
  input: Readonly<{ runner: RunnerConfig; role: ActiveRunnerRole }>,
): CliEffortChannel {
  const runner = input.runner;
  switch (runner.kind) {
    case 'cli':
      return CLI_TOOL_CATALOG[runner.tool].effortChannel;
    case 'api':
    case 'shell':
    case 'agent':
      return 'none';
    default:
      return assertNever(runner);
  }
}

/**
 * Only OpenAI-compatible endpoints hold the API seat, so the models.dev
 * `modalities.input ∋ 'image'` fact detection carries is the whole answer.
 */
export function seatSupportsImages(
  input: Readonly<{ runner: RunnerConfig; detected?: DetectedModelFact | undefined }>,
): boolean {
  const runner = input.runner;
  switch (runner.kind) {
    case 'cli':
      return true;
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
