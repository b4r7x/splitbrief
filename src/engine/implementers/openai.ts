import { join } from 'node:path';
import type { Config, TuiEvent, ImplementerResult } from '../../types.js';
import type { ImplementerOptions, RetryOptions } from '../implementer-utils.js';
import { createClient } from '../providers.js';
import { readFileOrEmpty } from '../../utils/fs.js';
import { toErrorMessage } from '../../utils/format.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../spec/formatter.js';
import { estimateTokens } from '../spec/token-budget.js';
import { streamCompletion } from '../openai-stream.js';
import { createGenEventEmitter, processImplementerOutput } from '../implementer-utils.js';

interface RunOpenAIOptions {
  projectDir: string;
  config: Config;
  prompt: string;
  temperature: number;
  onProgress: (text: string) => void;
  onEvent?: (event: TuiEvent) => void;
}

async function runOpenAIImplementer(
  opts: RunOpenAIOptions & { task: ImplementerOptions['task'] },
): Promise<ImplementerResult> {
  const { task, projectDir, config, prompt, temperature, onProgress, onEvent } = opts;
  const emitGenEvent = createGenEventEmitter(onEvent, config.implementer.model, task.file);

  emitGenEvent('running');

  const filePath = join(projectDir, task.file);
  const oldContent = readFileOrEmpty(filePath);

  const client = createClient(config);
  const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(prompt);
  const maxTokens = Math.max(config.implementer.contextLength - promptTokens, 1024);

  let implResult: ImplementerResult | undefined;
  try {
    let completion;
    try {
      completion = await streamCompletion(
        client,
        config.implementer.model,
        [
          { role: 'system', content: SYSTEM_PREAMBLE },
          { role: 'user', content: prompt },
        ],
        { temperature, onProgress, config, maxTokens },
      );
    } catch (err) {
      return { success: false, output: '', error: toErrorMessage(err) };
    }

    const usage = completion.usage;
    const result = await processImplementerOutput(completion.text, task, projectDir, oldContent);

    if (!result.success) {
      return { success: false, output: completion.text, error: result.error, usage };
    }

    emitGenEvent('done', { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved, diff: result.diff });
    implResult = { success: true, output: completion.text, usage };
    return implResult;
  } finally {
    if (!implResult?.success) emitGenEvent('failed');
  }
}

export async function implementTaskViaOpenAI(opts: ImplementerOptions): Promise<ImplementerResult> {
  const { task, projectDir, config, context, onProgress, onEvent } = opts;
  const prompt = formatTaskPrompt(task, context, config.implementer.contextLength);
  return runOpenAIImplementer({ task, projectDir, config, prompt, temperature: config.implementer.temperature, onProgress, onEvent });
}

export async function retryTaskViaOpenAI(opts: RetryOptions): Promise<ImplementerResult> {
  const { task, projectDir, config, context, error, attempt, onProgress, onEvent } = opts;
  const prompt = formatRetryPrompt(task, context, error, attempt, config.implementer.contextLength);
  const temperature = Math.min(config.implementer.temperature + attempt * 0.1, 2);
  return runOpenAIImplementer({ task, projectDir, config, prompt, temperature, onProgress, onEvent });
}
