import type { ImplementerResult } from '../types.js';
import type { ImplementerOptions, RetryOptions, ImplementerHandler } from './implementer-utils.js';
import { implementTaskViaShell, retryTaskViaShell } from './implementers/shell.js';
import { implementTaskViaAgent, retryTaskViaAgent } from './implementers/agent.js';
import { implementTaskViaOpenAI, retryTaskViaOpenAI } from './implementers/openai.js';

const handlers: Record<string, ImplementerHandler> = {
  agent: { implement: implementTaskViaAgent, retry: retryTaskViaAgent },
  shell: { implement: implementTaskViaShell, retry: retryTaskViaShell },
};

export async function implementTask(
  task: ImplementerOptions['task'],
  opts: Omit<ImplementerOptions, 'task'>,
): Promise<ImplementerResult> {
  const fullOpts: ImplementerOptions = { ...opts, task };
  const handler = handlers[opts.config.implementer.type ?? ''];
  if (handler) return handler.implement(fullOpts);
  return implementTaskViaOpenAI(fullOpts);
}

export async function retryTask(
  task: RetryOptions['task'],
  opts: Omit<RetryOptions, 'task'>,
): Promise<ImplementerResult> {
  const fullOpts: RetryOptions = { ...opts, task };
  const handler = handlers[opts.config.implementer.type ?? ''];
  if (handler) return handler.retry(fullOpts);
  return retryTaskViaOpenAI(fullOpts);
}
