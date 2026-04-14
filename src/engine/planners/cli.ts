import type { Config, InvokeResult } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { resolveAutoModel } from '../../core/providers.js';
import { assertPlannerKind } from './utils.js';

export function createCliPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'cli');
  const resolvedModel = resolveAutoModel(plannerCfg.model, plannerCfg.tool);
  const tool = CLI_TOOLS[plannerCfg.tool];
  if (!tool.planner) {
    throw new Error(`CLI tool '${plannerCfg.tool}' has no planner configuration`);
  }
  const planner = tool.planner;

  async function invoke(
    prompt: string,
    projectDir: string,
    onOutput: (text: string) => void,
    mode: 'plan' | 'escalate',
  ): Promise<InvokeResult> {
    let stderrOutput = '';
    const result = await spawnAndCollect({
      command: tool.command,
      args: planner.buildArgs({ prompt, model: resolvedModel, projectDir, mode }),
      cwd: projectDir,
      notFoundMessage: tool.notFoundMessage,
      parseLine: planner.parseLine,
      onText: onOutput,
      onStderr: planner.postProcess ? (chunk) => { stderrOutput += chunk; } : undefined,
    });

    if (planner.postProcess) return planner.postProcess(result.text, stderrOutput, result.usage);
    return result;
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks.onOutput, 'plan'),
    invokeEscalate: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks.onOutput, 'escalate'),
    hintSuccessMode: 'files',

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),
  });
}
