import type { InvokeResult } from '../../types.js';
import type { PlannerCallbacks, PlannerCapabilities } from './types.js';
import type { PlannerBaseConfig } from './base.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';
import { createCommandAvailability } from '../../utils/availability.js';
import type { OutputFormat } from '../../core/types/schemas/enums.js';

interface CommandPlannerInvokeOpts {
  command: string;
  args: string[];
  outputFormat: OutputFormat;
  notFoundMessage: string;
  /** When provided, called with `projectDir` to detect file changes (used by agent planner). */
  detectChanges?: ((projectDir: string) => Promise<boolean>) | undefined;
  extractsCode?: boolean | undefined;
}

export function createCommandPlannerInvoke(opts: CommandPlannerInvokeOpts) {
  return async ({
    prompt,
    projectDir,
    callbacks,
  }: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion'>;
  }): Promise<InvokeResult> => {
    const dc = opts.detectChanges;
    const result = await invokeCommandBasedRunner(
      {
        command: opts.command,
        args: opts.args,
        outputFormat: opts.outputFormat,
        extractsCode: opts.extractsCode ?? true,
        notFoundMessage: opts.notFoundMessage,
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
  const invoke = createCommandPlannerInvoke({
    command: config.command,
    args: config.args ?? [],
    outputFormat: config.outputFormat ?? 'text',
    extractsCode: overrides?.extractsCode,
    notFoundMessage: `${label} command not found: ${config.command}`,
    detectChanges: overrides?.detectChanges,
  });

  const defaultCapabilities: PlannerCapabilities = {
    supportsConversationalPlanning: false,
    supportsHintEscalation: false,
    supportsSessionResume: false,
    supportsMidStreamInjection: false,
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    capabilities: overrides?.capabilities ?? defaultCapabilities,
    ...(overrides?.readPhaseOutput && { readPhaseOutput: overrides.readPhaseOutput }),
    ...createCommandAvailability(config.command),
  });
}
