import type { Config, Task } from '../../types.js';
import type { Planner } from './types.js';
import { createCommandBasedPlanner } from './command-invoke.js';
import { buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { readSpecFile } from '../../core/paths-io.js';
import { getChangedFiles } from '../../utils/git.js';
import { assertPlannerKind } from './utils.js';
import { createChangeDetector } from '../change-detection.js';

export function createAgentPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'agent');

  const base = createCommandBasedPlanner(plannerCfg, 'Agent planner', {
    extractsCode: false,
    detectChanges: async (projectDir) => {
      const changed = await getChangedFiles(projectDir);
      return changed.length > 0;
    },
    readPhaseOutput: (filename, resultText, projectDir) =>
      readSpecFile(projectDir, filename) || resultText,
  });

  return {
    ...base,

    async escalateFull(task: Task, error: string, projectDir: string, callbacks: { onOutput: (text: string) => void }) {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
      const detect = createChangeDetector('Agent planner');
      const filesBefore = await getChangedFiles(projectDir);
      const result = await base.review(escalationPrompt, projectDir, callbacks);
      const { changed } = await detect(projectDir, filesBefore);
      return { success: changed, output: result.text, code: null, usage: result.usage };
    },
  };
}
