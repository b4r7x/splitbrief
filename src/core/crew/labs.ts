import { getApiProviderDescriptor } from '../providers/api-provider-catalog.js';
import type { CliToolId } from '../runners/cli-tool-catalog.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { assertNever } from '../../utils/type-guards.js';

export const CREW_LABS = Object.freeze(['anthropic', 'openai', 'deepseek'] as const);

export type CrewLab = (typeof CREW_LABS)[number];

export type CrewLabResolution =
  | Readonly<{ kind: 'known'; lab: CrewLab }>
  | Readonly<{ kind: 'undetermined' }>;

export type CrewLabVerdict = 'cross-lab' | 'same-lab';

const UNDETERMINED: CrewLabResolution = Object.freeze({ kind: 'undetermined' });

/**
 * Only tools that front exactly one lab. A tool that runs whatever provider its
 * own config names — opencode, aider, copilot, kilo-code — stays undetermined.
 */
const CLI_TOOL_LABS: Readonly<Partial<Record<CliToolId, CrewLab>>> = Object.freeze({
  'claude-code': 'anthropic',
  codex: 'openai',
});

function labNamed(value: string): CrewLab | undefined {
  return CREW_LABS.find((lab) => lab === value);
}

// A vendor-prefixed model id overrides the endpoint it is served from, so a
// prefix naming anything but the service's own lab leaves the seat undetermined.
function modelVendorConflicts(model: string | undefined, lab: CrewLab): boolean {
  if (model === undefined) return false;
  const separator = model.indexOf('/');
  if (separator <= 0) return false;
  return model.slice(0, separator) !== lab;
}

function resolveApiLab(runner: Extract<RunnerConfig, { kind: 'api' }>): CrewLabResolution {
  const descriptor = getApiProviderDescriptor(runner.provider);
  if (descriptor === undefined) return UNDETERMINED;

  const lab = labNamed(descriptor.service);
  if (lab === undefined) return UNDETERMINED;
  if (modelVendorConflicts(runner.model, lab)) return UNDETERMINED;
  return { kind: 'known', lab };
}

export function resolveLab(runner: RunnerConfig): CrewLabResolution {
  switch (runner.kind) {
    case 'cli': {
      const lab = CLI_TOOL_LABS[runner.tool];
      return lab === undefined ? UNDETERMINED : { kind: 'known', lab };
    }
    case 'api':
      return resolveApiLab(runner);
    case 'agent-sdk':
      return { kind: 'known', lab: 'anthropic' };
    case 'shell':
    case 'agent':
      return UNDETERMINED;
    default:
      return assertNever(runner);
  }
}

export function crossLabVerdict(
  seats: Readonly<{ build: CrewLabResolution; review: CrewLabResolution }>,
): CrewLabVerdict | undefined {
  if (seats.build.kind === 'undetermined' || seats.review.kind === 'undetermined') return undefined;
  return seats.build.lab === seats.review.lab ? 'same-lab' : 'cross-lab';
}
