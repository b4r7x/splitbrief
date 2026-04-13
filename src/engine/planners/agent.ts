import type { Config, Task } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { createCommandPlannerInvoke } from './command-invoke.js';
import { buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { readSpecFile } from '../../core/paths-io.js';
import { getChangedFiles } from '../../utils/git.js';

export function createAgentPlanner(config: Config): Planner {
  if (config.planner.kind !== 'agent') {
    throw new Error(`createAgentPlanner requires planner.kind = 'agent' (got ${config.planner.kind})`);
  }
  const plannerCfg = config.planner;
  const command = plannerCfg.command;

  const invoke = createCommandPlannerInvoke({
    command,
    args: plannerCfg.args ?? [],
    outputFormat: plannerCfg.outputFormat ?? 'text',
    extractsCode: false,
    notFoundMessage: `Agent planner command not found: ${command}`,
    detectChanges: async (projectDir) => {
      const changed = await getChangedFiles(projectDir);
      return changed.length > 0;
    },
  });

  const base = createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    readPhaseOutput: (filename, resultText, projectDir) =>
      readSpecFile(projectDir, filename) || resultText,
    ...createCommandAvailability(command),
  });

  return {
    ...base,

    async escalateFull(task: Task, error: string, projectDir: string, callbacks: { onOutput: (text: string) => void }) {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
      const result = await invoke({ prompt: escalationPrompt, projectDir, callbacks });
      const changedFiles = await getChangedFiles(projectDir);
      return { success: changedFiles.length > 0, output: result.text, code: null, usage: null };
    },
  };
}
