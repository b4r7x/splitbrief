import type { Config } from '../../core/schemas/config.js';
import type { Planner } from './types.js';
import { createCommandBasedPlanner, resolveCapabilities } from './command-invoke.js';
import { readSpecFile } from '../../core/paths-io.js';
import { assertPlannerKind } from '../config-assertions.js';

export function createAgentPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'agent');

  return createCommandBasedPlanner(
    {
      command: plannerCfg.command,
      args: plannerCfg.args ?? [],
      outputFormat: plannerCfg.outputFormat ?? 'text',
      idleWarnMs: plannerCfg.idleWarnMs,
      idleKillMs: plannerCfg.idleKillMs,
    },
    'Agent planner',
    {
      notFoundMessage: `Agent planner command not found: ${plannerCfg.command}`,
      escalateFullMode: 'files',
      capabilities: resolveCapabilities(plannerCfg.capabilities),
      readPhaseOutput: (filename, resultText, projectDir, sessionId) =>
        (sessionId ? readSpecFile({ projectDir, sessionId }, filename) : null) ?? resultText,
    },
  );
}
