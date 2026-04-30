import type { Config } from '../../core/schemas/config.js';
import type { Planner } from '../planners/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { RunnerKind } from '../../core/schemas/enums.js';
import { warnStderr } from '../../lib/warn.js';

import { createClaudeCodePlanner } from '../planners/claude-code.js';
import { createCliPlanner } from '../planners/cli.js';
import { createApiPlanner } from '../planners/api.js';
import { createShellPlanner } from '../planners/shell.js';
import { createAgentPlanner } from '../planners/agent.js';
import { createAgentSdkPlanner } from '../planners/agent-sdk.js';

import { createCliImplementer } from '../implementers/cli.js';
import { createApiImplementer } from '../implementers/api.js';
import { createShellImplementer } from '../implementers/shell.js';
import { createAgentImplementer } from '../implementers/agent.js';
import { createAgentSdkImplementer } from '../implementers/agent-sdk.js';
import { runnerConfigError } from './errors.js';

const PLANNER_FACTORIES: Record<RunnerKind, (config: Config, initialSessionId?: string | null) => Planner> = {
  cli: (c, initialSessionId) => {
    if (c.planner.kind !== 'cli') throw runnerConfigError.kindMismatch('cli', c.planner.kind, 'planner');
    return c.planner.tool === 'claude-code'
      ? createClaudeCodePlanner(c.planner.model, initialSessionId, c.planner.effort)
      : createCliPlanner(c, initialSessionId);
  },
  api: createApiPlanner,
  shell: createShellPlanner,
  agent: createAgentPlanner,
  'agent-sdk': (c, initialSessionId) => {
    if (c.planner.kind !== 'agent-sdk') throw runnerConfigError.kindMismatch('agent-sdk', c.planner.kind, 'planner');
    return createAgentSdkPlanner(c.planner.model, c.planner.apiKey, initialSessionId, c.planner.effort);
  },
};

const IMPLEMENTER_FACTORIES: Record<RunnerKind, (config: Config, options?: ImplementerFactoryOptions) => Implementer> = {
  cli: (c, options) => {
    if (c.implementer.kind !== 'cli') throw runnerConfigError.kindMismatch('cli', c.implementer.kind, 'implementer');
    return createCliImplementer(c.implementer, options);
  },
  api: createApiImplementer,
  shell: createShellImplementer,
  agent: createAgentImplementer,
  'agent-sdk': createAgentSdkImplementer,
};

export function createPlanner(config: Config, initialSessionId?: string | null): Planner {
  const factory = PLANNER_FACTORIES[config.planner.kind];
  if (!factory) throw runnerConfigError.invalidKind(config.planner.kind, 'planner');
  const planner = factory(config, initialSessionId);
  if (config.planner.effort && !planner.capabilities.supportsEffort) {
    warnStderr(`planner-effort: dropped (${config.planner.kind} backend has no reasoning control)`);
  }
  return planner;
}

export function createImplementer(config: Config, options?: ImplementerFactoryOptions): Implementer {
  const factory = IMPLEMENTER_FACTORIES[config.implementer.kind];
  if (!factory) throw runnerConfigError.invalidKind(config.implementer.kind, 'implementer');
  return factory(config, options);
}
