import type { Config } from '../../core/schemas/config.js';
import type { InvokeResult } from '../runners/types.js';
import type { Planner, PlannerCallbacks } from './types.js';
import { createPlannerBase } from './base.js';
import { resolveCapabilities } from './command-invoke.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';
import { createCommandAvailability } from '../availability.js';
import { readSpecFile } from '../../core/paths-io.js';
import { assertPlannerKind } from '../config-assertions.js';

export function createAgentPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'agent');
  const capabilities = resolveCapabilities(plannerCfg.capabilities);
  const notFoundMessage = `Agent planner command not found: ${plannerCfg.command}`;

  const invoke = async ({
    prompt,
    projectDir,
    callbacks,
  }: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion'>;
  }): Promise<InvokeResult> => {
    const result = await invokeCommandBasedRunner(
      {
        command: plannerCfg.command,
        args: plannerCfg.args ?? [],
        outputFormat: plannerCfg.outputFormat ?? 'text',
        notFoundMessage,
      },
      prompt,
      projectDir,
      callbacks.onOutput,
    );

    if (callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(result.stdout);
      if (questions.length > 0) callbacks.onQuestion(questions);
    }

    return { text: result.stdout, usage: result.usage ?? null };
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    escalateFullMode: 'files',
    readPhaseOutput: (filename, resultText, projectDir, sessionId) =>
      (sessionId ? readSpecFile(projectDir, sessionId, filename) : null) ?? resultText,
    capabilities,
    ...createCommandAvailability(plannerCfg.command),
  });
}
