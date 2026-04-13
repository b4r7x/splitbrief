import type { InvokeResult } from '../../types.js';
import type { PlannerCallbacks } from './types.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';
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

    return { text: result.stdout, usage: null };
  };
}
