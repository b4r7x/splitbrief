import { stripVendorPrefix } from '../model-display.js';
import { isProviderId, type ProviderId } from '../schemas/enums.js';
import { assertNever } from '../../utils/type-guards.js';
import { CLI_TOOL_CATALOG, type ActiveRunnerRole } from './cli-tool-catalog.js';
import type { ProviderDetection } from '../discovery/detection.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { resolveAutoModel } from '../providers/model-selection.js';

/** The models.dev fact for one model; absent when detection never reached it. */
export type DetectedModelFact = Readonly<{ supportsImages?: boolean }>;

/** The normalized form every model predicate matches on, in core and in the engine. */
export function modelKey(model: string): string {
  return stripVendorPrefix(model).toLowerCase();
}

const ANTHROPIC_IMAGE_MODEL_RE =
  /claude-(?:(opus|sonnet|haiku)-[3-9]|[3-9](?:[-.]\d+)?-(opus|sonnet|haiku))/i;
const OPENAI_IMAGE_MODEL_RE = /gpt-4o|gpt-4-vision|gpt-4\.1|gpt-5|o[34]/i;

export function modelSupportsEffort(provider: ProviderId, model: string | undefined): boolean {
  if (!model) return false;
  const key = provider === 'openrouter' ? modelKey(model) : model;
  if (provider === 'anthropic') return /claude-(opus|sonnet)-[4-9]/i.test(key);
  if (provider === 'openai' || provider === 'openrouter')
    return /^(o[1345]|gpt-[5-9])/i.test(key) || /(?:^|-)r1(?:-|$)|reasoner/i.test(key);
  if (provider === 'deepseek') return /(?:^|-)r1(?:-|$)|reasoner|deepseek-v4/i.test(key);
  return false;
}

/**
 * The models.dev `modalities.input ∋ 'image'` fact wins whenever detection
 * carries it; the name regexes are the cold-start fallback.
 */
export function modelSupportsImages(
  provider: ProviderId,
  model: string | undefined,
  detected?: DetectedModelFact | undefined,
): boolean {
  if (detected?.supportsImages !== undefined) return detected.supportsImages;
  if (!model) return false;
  const key = provider === 'openrouter' ? modelKey(model) : model;
  if (provider === 'anthropic') return ANTHROPIC_IMAGE_MODEL_RE.test(key);
  if (provider === 'openai') return OPENAI_IMAGE_MODEL_RE.test(key);
  if (provider === 'openrouter') return true;
  return false;
}

export function seatSupportsEffort(
  input: Readonly<{ runner: RunnerConfig; role: ActiveRunnerRole }>,
): boolean {
  const runner = input.runner;
  switch (runner.kind) {
    case 'cli':
      return CLI_TOOL_CATALOG[runner.tool].supportsEffort && input.role !== 'implementer';
    case 'api':
      return (
        isProviderId(runner.provider) &&
        modelSupportsEffort(runner.provider, resolveAutoModel(runner.model, runner.provider))
      );
    case 'agent-sdk':
      return true;
    case 'shell':
    case 'agent':
      return false;
    default:
      return assertNever(runner);
  }
}

export function seatSupportsImages(
  input: Readonly<{ runner: RunnerConfig; detected?: DetectedModelFact | undefined }>,
): boolean {
  const runner = input.runner;
  switch (runner.kind) {
    case 'cli':
    case 'agent-sdk':
      return true;
    case 'api':
      return (
        isProviderId(runner.provider) &&
        modelSupportsImages(runner.provider, runner.model, input.detected)
      );
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
  const model = detection?.models?.find((candidate) => candidate.id === runner.model);
  if (model === undefined) return undefined;
  return model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages };
}
