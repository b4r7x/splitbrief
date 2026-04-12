import type { Config } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';

export function createShellPlanner(config: Config): Planner {
  if (config.planner.kind !== 'shell') {
    throw new Error(`createShellPlanner requires planner.kind = 'shell' (got ${config.planner.kind})`);
  }
  const plannerCfg = config.planner;
  const command = plannerCfg.command;
  const baseArgs = plannerCfg.args ?? [];
  const notFoundMessage = `Shell planner command not found: ${command}`;

  const invoke: Parameters<typeof createPlannerBase>[0]['invokePlan'] = async ({ prompt, projectDir, callbacks }) => {
    const result = await invokeCommandBasedRunner(
      {
        command,
        args: baseArgs,
        outputFormat: plannerCfg.outputFormat ?? 'text',
        extractsCode: true,
        notFoundMessage,
      },
      prompt,
      projectDir,
      callbacks.onOutput,
    );

    if (callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(result.stdout);
      if (questions.length > 0) {
        callbacks.onQuestion(questions);
      }
    }

    return { text: result.stdout, usage: null };
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    ...createCommandAvailability(command),
  });
}
