import type { CliToolId } from '../runners/cli-tool-catalog.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { assertNever } from '../../utils/type-guards.js';

export const CREW_LABS = Object.freeze(['anthropic', 'openai'] as const);

export type CrewLab = (typeof CREW_LABS)[number];

export type CrewLabResolution =
  | Readonly<{ kind: 'known'; lab: CrewLab }>
  | Readonly<{ kind: 'undetermined' }>;

export type CrewLabVerdict = 'cross-lab' | 'same-lab';

const UNDETERMINED: CrewLabResolution = Object.freeze({ kind: 'undetermined' });

/**
 * Only tools that front exactly one lab. A tool that runs whatever provider its
 * own config names stays undetermined.
 */
const CLI_TOOL_LABS: Readonly<Partial<Record<CliToolId, CrewLab>>> = Object.freeze({
  'claude-code': 'anthropic',
  codex: 'openai',
});

export function resolveLab(runner: RunnerConfig): CrewLabResolution {
  switch (runner.kind) {
    case 'cli': {
      const lab = CLI_TOOL_LABS[runner.tool];
      return lab === undefined ? UNDETERMINED : { kind: 'known', lab };
    }
    // No admitted API provider fronts a lab — both are local runtimes serving
    // whatever model the user loaded — so an endpoint names no lab either.
    case 'api':
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
