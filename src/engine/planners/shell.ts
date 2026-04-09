import type { Config, OutputFormat } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';

export function createShellPlanner(config: Config): Planner {
  if (config.planner.kind !== 'shell') {
    throw new Error(`createShellPlanner requires planner.kind = 'shell' (got ${config.planner.kind})`);
  }
  const plannerCfg = config.planner;
  const command = plannerCfg.command;
  const baseArgs = plannerCfg.args ?? [];
  const format: OutputFormat = plannerCfg.outputFormat ?? 'text';
  const notFoundMessage = `Shell planner command not found: ${command}`;

  const invoke = ({ prompt, projectDir, callbacks }: { prompt: string; projectDir: string; callbacks: { onOutput: (text: string) => void } }) =>
    spawnAndCollect({
      command,
      args: baseArgs,
      cwd: projectDir,
      stdin: prompt,
      format,
      notFoundMessage,
      onText: callbacks.onOutput,
    });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    ...createCommandAvailability(command),
  });
}
