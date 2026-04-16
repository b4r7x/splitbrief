import type { InvokeResult } from '../../types.js';
import type { PlannerCallbacks, PlannerCapabilities } from './types.js';
import type { PlannerBaseConfig } from './base.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';
import { createCommandAvailability } from '../../utils/availability.js';
import type { OutputFormat } from '../../core/types/schemas/enums.js';

export function resolveCapabilities(override: { [K in keyof PlannerCapabilities]?: boolean | undefined } | undefined): PlannerCapabilities {
  return {
    supportsConversationalPlanning: override?.supportsConversationalPlanning ?? false,
    supportsHintEscalation: override?.supportsHintEscalation ?? false,
    supportsSessionResume: override?.supportsSessionResume ?? false,
    supportsMidStreamInjection: override?.supportsMidStreamInjection ?? false,
  };
}

/**
 * Creates a command-based planner (shared setup for shell + agent kinds).
 * Handles: config extraction, invoke wiring, availability, and base planner construction.
 */
export function createCommandBasedPlanner(
  config: { command: string; args?: string[] | undefined; outputFormat?: OutputFormat | undefined },
  label: string,
  overrides?: {
    extractsCode?: boolean | undefined;
    detectChanges?: ((projectDir: string) => Promise<boolean>) | undefined;
    readPhaseOutput?: PlannerBaseConfig['readPhaseOutput'] | undefined;
    capabilities?: PlannerCapabilities | undefined;
  },
): Planner {
  const notFoundMessage = `${label} command not found: ${config.command}`;
  const dc = overrides?.detectChanges;
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
        command: config.command,
        args: config.args ?? [],
        outputFormat: config.outputFormat ?? 'text',
        extractsCode: overrides?.extractsCode ?? true,
        notFoundMessage,
        ...(dc ? { detectChanges: () => dc(projectDir) } : {}),
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

    return { text: result.stdout, usage: result.usage ?? null };
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    capabilities: resolveCapabilities(overrides?.capabilities),
    ...(overrides?.readPhaseOutput && { readPhaseOutput: overrides.readPhaseOutput }),
    ...createCommandAvailability(config.command),
  });
}
