import type { Config } from '../../types.js';
import type { Planner } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import type { RunnerKind } from '../../core/types/schemas/enums.js';

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

import { dispatchRunner } from '../../utils/runner-dispatch.js';

const PLANNER_FACTORIES: Record<RunnerKind, (config: Config, initialSessionId?: string | null) => Planner> = {
  cli: (c, initialSessionId) => {
    if (c.planner.kind !== 'cli') throw new Error(`PLANNER_FACTORIES['cli']: expected planner.kind='cli', got '${c.planner.kind}'`);
    return c.planner.tool === 'claude-code'
      ? createClaudeCodePlanner(c.planner.model, initialSessionId)
      : createCliPlanner(c, initialSessionId);
  },
  api: createApiPlanner,
  shell: createShellPlanner,
  agent: createAgentPlanner,
  'agent-sdk': (c, initialSessionId) => {
    if (c.planner.kind !== 'agent-sdk') throw new Error(`PLANNER_FACTORIES['agent-sdk']: expected planner.kind='agent-sdk', got '${c.planner.kind}'`);
    return createAgentSdkPlanner(c.planner.model, c.planner.apiKey, initialSessionId);
  },
};

const IMPLEMENTER_FACTORIES: Record<RunnerKind, (config: Config) => Implementer> = {
  cli: (c) => {
    if (c.implementer.kind !== 'cli') throw new Error(`IMPLEMENTER_FACTORIES['cli']: expected implementer.kind='cli', got '${c.implementer.kind}'`);
    return createCliImplementer(c.implementer);
  },
  api: createApiImplementer,
  shell: createShellImplementer,
  agent: createAgentImplementer,
  'agent-sdk': createAgentSdkImplementer,
};

export function createPlanner(config: Config, initialSessionId?: string | null): Planner {
  const factory = PLANNER_FACTORIES[config.planner.kind];
  if (!factory) throw new Error(`No planner factory for kind '${config.planner.kind}'`);
  return factory(config, initialSessionId);
}

export function createImplementer(config: Config): Implementer {
  return dispatchRunner(config.implementer.kind, IMPLEMENTER_FACTORIES, 'implementer', config);
}
