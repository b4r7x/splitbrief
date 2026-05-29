import type { Config } from '../../schemas/config.js';
import { resolveAutoModel } from '../../providers/model-selection.js';
import { isPlannerToolId, type PlannerToolId } from '../../schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';

export type RunnerConfig = Config['planner'] | Config['implementer'];

export function getRunnerDisplayName(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    case 'agent-sdk':
      return 'agent-sdk';
    default:
      return assertNever(runner);
  }
}

export function getRunnerCommand(runner: RunnerConfig): string | undefined {
  if ('command' in runner && typeof runner.command === 'string') {
    return runner.command;
  }
  return undefined;
}

export function getRunnerApiKey(runner: RunnerConfig): string | undefined {
  if ('apiKey' in runner && typeof runner.apiKey === 'string') {
    return runner.apiKey;
  }
  return undefined;
}

export function getRunnerModelName(runner: RunnerConfig): string | undefined {
  if ('model' in runner && typeof runner.model === 'string') {
    return resolveAutoModel(runner.model, getRunnerDisplayName(runner));
  }
  return undefined;
}

export function hasApiBase(
  runner: RunnerConfig,
): runner is Extract<RunnerConfig, { apiBase: string }> {
  return 'apiBase' in runner && typeof runner.apiBase === 'string' && runner.apiBase.length > 0;
}

export function getPlannerToolId(config: Config['planner']): PlannerToolId {
  switch (config.kind) {
    case 'cli':
      return config.tool;
    case 'api': {
      const provider = config.provider;
      return isPlannerToolId(provider) ? provider : 'anthropic';
    }
    case 'shell':
      return 'shell';
    case 'agent-sdk':
      return 'agent-sdk';
    case 'agent':
      return 'agent';
    default:
      return assertNever(config);
  }
}
