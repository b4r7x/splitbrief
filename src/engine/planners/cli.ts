import type { InvokeResult } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import type { CliPlannerTool } from '../../types.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { resolveAutoModel } from '../../core/providers/models.js';

type CliPlannerKind = Exclude<CliPlannerTool, 'claude-code'>;

export function createCliPlanner(kind: CliPlannerKind, model?: string): Planner {
  const resolvedModel = resolveAutoModel(model);
  const tool = CLI_TOOLS[kind];
  if (!tool.planner) {
    throw new Error(`CLI tool '${kind}' has no planner configuration`);
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

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),
  });
}
