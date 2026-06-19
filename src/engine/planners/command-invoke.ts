import type { Planner, PlannerCallbacks, PlannerCapabilities } from './types.js';
import { createPlannerBase, type PlannerBaseConfig } from './base.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question.js';
import { createCommandExistsAvailability } from '../availability.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { RunnerCallResult } from '../calls/types.js';

export function resolveCapabilities(
  override: { [K in keyof PlannerCapabilities]?: boolean | undefined } | undefined,
): PlannerCapabilities {
  return {
    supportsConversationalPlanning: override?.supportsConversationalPlanning ?? false,
    supportsHintEscalation: override?.supportsHintEscalation ?? false,
    supportsSessionResume: override?.supportsSessionResume ?? false,
    supportsEffort: override?.supportsEffort ?? false,
    supportsImages: override?.supportsImages ?? false,
    supportsSelfSummarisation: override?.supportsSelfSummarisation ?? false,
  };
}

export function createCommandBasedPlanner(
  config: { command: string; args?: string[] | undefined; outputFormat?: OutputFormat | undefined },
  label: string,
  overrides?: {
    readPhaseOutput?: PlannerBaseConfig['readPhaseOutput'] | undefined;
    capabilities?: PlannerCapabilities | undefined;
    escalateFullMode?: PlannerBaseConfig['escalateFullMode'] | undefined;
    notFoundMessage?: string | undefined;
  },
): Planner {
  const notFoundMessage =
    overrides?.notFoundMessage ?? `${label} command not found: ${config.command}`;
  const invoke = async ({
    prompt,
    projectDir,
    callbacks,
    signal,
    sandboxEnv,
    callContext,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onCallEvent'>;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> => {
    const result = await invokeCommandBasedRunner({
      command: config.command,
      args: config.args ?? [],
      outputFormat: config.outputFormat ?? 'text',
      notFoundMessage,
      prompt,
      projectDir,
      env: sandboxEnv,
      onOutput: callbacks.onOutput,
      onCallEvent: callbacks.onCallEvent,
      callContext,
      signal,
    });

    if (callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(result.stdout);
      if (questions.length > 0) {
        callbacks.onQuestion(questions);
      }
    }

    return result.callResult;
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'cli',
    runnerName: config.command,
    hintSuccessMode: 'files',
    capabilities: resolveCapabilities(overrides?.capabilities),
    ...(overrides?.escalateFullMode && { escalateFullMode: overrides.escalateFullMode }),
    ...(overrides?.readPhaseOutput && { readPhaseOutput: overrides.readPhaseOutput }),
    ...createCommandExistsAvailability(config.command),
  });
}
