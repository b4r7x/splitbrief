import type { ImplementerOptions, RetryOptions } from '../types.js';
import type { ImplementerWriteMode } from '../../../core/schemas/runner/implementer.js';
import type { BuildOutputContract } from '../file-bundle/contract.js';
import { formatTaskPrompt, formatRetryPrompt } from '../../spec/prompts/task.js';
import { worksInPlace } from './checkout-guard.js';

export function taskPrompt(
  opts: ImplementerOptions,
  writesFiles: ImplementerWriteMode,
  outputContract: BuildOutputContract,
): string {
  return formatTaskPrompt({
    task: opts.task,
    context: opts.context,
    contextLength: opts.config.implementer.contextLength,
    languageContext: opts.languageContext,
    writesFiles,
    outputContract,
    plan: opts.plan,
    inPlace: worksInPlace(opts),
  });
}

export function retryPrompt(
  opts: RetryOptions,
  writesFiles: ImplementerWriteMode,
  outputContract: BuildOutputContract,
): string {
  return formatRetryPrompt({
    task: opts.task,
    context: opts.context,
    error: opts.error,
    attempt: opts.attempt,
    kind: opts.kind,
    contextLength: opts.config.implementer.contextLength,
    languageContext: opts.languageContext,
    writesFiles,
    outputContract,
    plan: opts.plan,
    inPlace: worksInPlace(opts),
  });
}
