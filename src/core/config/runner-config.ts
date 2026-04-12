import type { Config } from '../types/config.js';
import { resolveAutoModel } from '../providers/models.js';

export type RunnerConfig = Config['planner'] | Config['implementer'];

export function getRunnerDisplayName(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':       return runner.tool;
    case 'api':       return runner.provider;
    case 'shell':     return 'shell';
    case 'agent':     return 'agent';
    case 'agent-sdk': return 'agent-sdk';
    default: {
      const _exhaustive: never = runner;
      return _exhaustive;
    }
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
    return resolveAutoModel(runner.model);
  }
  return undefined;
}

export function hasApiBase(runner: RunnerConfig): runner is Extract<RunnerConfig, { apiBase: string }> {
  return 'apiBase' in runner && typeof runner.apiBase === 'string' && runner.apiBase.length > 0;
}
