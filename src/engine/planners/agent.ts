import type { Config } from '../../core/schemas/config.js';
import type { Task } from '../../core/schemas/task.js';
import type { Planner } from './types.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import { createCommandBasedPlanner, resolveCapabilities } from './command-invoke.js';
import { buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { readSpecFile } from '../../core/paths-io.js';
import { getCurrentChangedFiles } from '../../lib/git.js';
import { assertPlannerKind } from '../config-assertions.js';
import { createChangeDetector } from '../change-detection.js';

export function createAgentPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'agent');
  const capabilities = resolveCapabilities(plannerCfg.capabilities);

  const base = createCommandBasedPlanner(plannerCfg, 'Agent planner', {
    readPhaseOutput: (filename, resultText, projectDir, sessionId) =>
      (sessionId ? readSpecFile(projectDir, sessionId, filename) : null) ?? resultText,
    capabilities,
  });

  return {
    ...base,

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
      languageContext?: LanguageContext,
    ) {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error, languageContext);
      const detect = createChangeDetector('Agent planner');
      const filesBefore = await getCurrentChangedFiles(projectDir);
      const result = await base.review(escalationPrompt, projectDir, callbacks);
      const { changed } = await detect(projectDir, filesBefore);
      return { success: changed, output: result.text, code: null, usage: result.usage };
    },
  };
}
