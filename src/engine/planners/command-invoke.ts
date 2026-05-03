import type { InvokeResult } from '../runners/types.js';
import type { PlannerCallbacks, PlannerCapabilities } from './types.js';
import type { PlannerBaseConfig } from './base.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { getChangedFiles } from '../../lib/git.js';
import type { OutputFormat } from '../../core/schemas/enums.js';

export function resolveCapabilities(override: { [K in keyof PlannerCapabilities]?: boolean | undefined } | undefined): PlannerCapabilities {
  return {
    supportsConversationalPlanning: override?.supportsConversationalPlanning ?? false,
    supportsHintEscalation: override?.supportsHintEscalation ?? false,
    supportsSessionResume: override?.supportsSessionResume ?? false,
    supportsEffort: override?.supportsEffort ?? false,
    supportsImages: override?.supportsImages ?? false,
    supportsSelfSummarisation: override?.supportsSelfSummarisation ?? false,
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
    detectChanges?: ((projectDir: string, before: string[]) => Promise<{ changed: boolean; output: string }>) | undefined;
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
    const filesBefore = dc ? await getChangedFiles(projectDir) : [];
    const result = await invokeCommandBasedRunner(
      {
        command: config.command,
        args: config.args ?? [],
        outputFormat: config.outputFormat ?? 'text',
        extractsCode: overrides?.extractsCode ?? true,
        notFoundMessage,
        ...(dc ? { detectChanges: () => dc(projectDir, filesBefore) } : {}),
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
