import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Task, Config, ProjectContext, TuiEvent } from '../types.js';
import { createClient } from './providers.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE, estimateTokens } from './spec/formatter.js';
import { extractCode } from './extractor.js';
import { validateTaskPath } from '../utils/fs.js';
import { implementTaskViaShell, retryTaskViaShell } from './implementers/shell.js';
import { implementTaskViaAgent, retryTaskViaAgent } from './implementers/agent.js';
import { computeDiff } from '../utils/diff.js';

export function applyCode(code: string, task: Task, projectDir: string): { success: boolean; error?: string } {
  try {
    validateTaskPath(projectDir, task.file);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const filePath = join(projectDir, task.file);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (task.action === 'create') {
    writeFileSync(filePath, code, 'utf-8');
    return { success: true };
  }

  if (!existsSync(filePath)) {
    writeFileSync(filePath, code, 'utf-8');
    return { success: true };
  }

  const existing = readFileSync(filePath, 'utf-8');
  const lineCount = existing.split('\n').length;

  if (lineCount < 200) {
    writeFileSync(filePath, code, 'utf-8');
    return { success: true };
  }

  // For large files, attempt search/replace via markers in the code
  // Fall back to whole-file replacement if no markers found
  const searchReplaceRegex = /<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;
  let hasMarkers = false;
  let result = existing;

  while ((match = searchReplaceRegex.exec(code)) !== null) {
    hasMarkers = true;
    const search = match[1].trimEnd();
    const replace = match[2].trimEnd();

    if (!result.includes(search)) {
      return { success: false, error: `Search block not found in ${task.file}:\n${search.slice(0, 200)}` };
    }

    result = result.replace(search, replace);
  }

  if (hasMarkers) {
    writeFileSync(filePath, result, 'utf-8');
    return { success: true };
  }

  // No markers found, fall back to whole-file replacement
  writeFileSync(filePath, code, 'utf-8');
  return { success: true };
}

interface CompletionResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}

async function streamCompletion(
  client: ReturnType<typeof createClient>,
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  temperature: number,
  onProgress: (text: string) => void,
  config: Config,
  maxTokens?: number,
): Promise<CompletionResult> {
  let stream;
  try {
    stream = await client.chat.completions.create({
      model,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown>;
    const causeObj = (typeof errObj?.cause === 'object' && errObj.cause !== null ? errObj.cause : {}) as Record<string, unknown>;
    if (errObj?.code === 'ECONNREFUSED' || causeObj?.code === 'ECONNREFUSED') {
      const baseURL = config.implementer.apiBase || `${config.implementer.provider} default`;
      throw new Error(
        `Cannot connect to ${config.implementer.provider} at ${baseURL}. Is it running?`,
      );
    }
    if (typeof errObj?.status === 'number' && errObj.status >= 400) {
      throw new Error(
        `API error ${errObj.status} from ${config.implementer.provider}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
    throw err;
  }

  let fullResponse = '';
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  const timeout = 60_000;
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error('Model response timed out after 60 seconds')), timeout);
  });

  try {
    await Promise.race([
      (async () => {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            onProgress(content);
          }
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Model response timed out after 60 seconds') {
      throw err;
    }
    const errObj = err as Record<string, unknown>;
    const causeObj = (typeof errObj?.cause === 'object' && errObj.cause !== null ? errObj.cause : {}) as Record<string, unknown>;
    if (errObj?.code === 'ECONNREFUSED' || causeObj?.code === 'ECONNREFUSED') {
      const baseURL = config.implementer.apiBase || `${config.implementer.provider} default`;
      throw new Error(
        `Cannot connect to ${config.implementer.provider} at ${baseURL}. Is it running?`,
      );
    }
    if (typeof errObj?.status === 'number' && errObj.status >= 400) {
      throw new Error(
        `API error ${errObj.status} from ${config.implementer.provider}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timerId!);
  }

  return { text: fullResponse, usage };
}

export async function implementTask(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  onProgress: (text: string) => void,
  onEvent?: (event: TuiEvent) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const modelName = config.implementer.model;

  if (config.implementer.type === 'agent') {
    return implementTaskViaAgent(task, projectDir, config, context, onProgress);
  }

  if (config.implementer.type === 'shell') {
    return implementTaskViaShell(task, projectDir, config, context, onProgress);
  }

  onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'running', model: modelName, file: task.file });
  const startTime = Date.now();

  const filePath = join(projectDir, task.file);
  const oldContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';

  const userPrompt = formatTaskPrompt(task, context, config.implementer.contextLength);
  const client = createClient(config);
  const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(userPrompt);
  const maxTokens = Math.max(config.implementer.contextLength - promptTokens, 1024);

  let completion: CompletionResult;
  try {
    completion = await streamCompletion(
      client,
      config.implementer.model,
      [
        { role: 'system', content: SYSTEM_PREAMBLE },
        { role: 'user', content: userPrompt },
      ],
      config.implementer.temperature,
      onProgress,
      config,
      maxTokens,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model: modelName, file: task.file, duration: Date.now() - startTime });
    return { success: false, output: '', error: msg };
  }

  const extractResult = extractCode(completion.text);

  if ('error' in extractResult) {
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model: modelName, file: task.file, duration: Date.now() - startTime });
    return { success: false, output: completion.text, error: extractResult.error, usage: completion.usage ?? undefined };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model: modelName, file: task.file, duration: Date.now() - startTime });
    return { success: false, output: completion.text, error: applyResult.error, usage: completion.usage ?? undefined };
  }

  const newContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const { diff, linesAdded, linesRemoved } = computeDiff(oldContent, newContent);
  onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'done', model: modelName, file: task.file, linesAdded, linesRemoved, diff, duration: Date.now() - startTime });

  return { success: true, output: completion.text, usage: completion.usage ?? undefined };
}

export async function retryTask(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  error: string,
  attempt: number,
  onProgress: (text: string) => void,
  onEvent?: (event: TuiEvent) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const modelName = config.implementer.model;

  if (config.implementer.type === 'agent') {
    return retryTaskViaAgent(task, projectDir, config, context, error, attempt, onProgress);
  }

  if (config.implementer.type === 'shell') {
    return retryTaskViaShell(task, projectDir, config, context, error, attempt, onProgress);
  }

  onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'running', model: modelName, file: task.file });
  const startTime = Date.now();

  const filePath = join(projectDir, task.file);
  const oldContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';

  const retryPrompt = formatRetryPrompt(task, context, error, attempt);
  const client = createClient(config);
  const temperature = Math.min(config.implementer.temperature + attempt * 0.1, 2);
  const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(retryPrompt);
  const maxTokens = Math.max(config.implementer.contextLength - promptTokens, 1024);

  let completion: CompletionResult;
  try {
    completion = await streamCompletion(
      client,
      config.implementer.model,
      [
        { role: 'system', content: SYSTEM_PREAMBLE },
        { role: 'user', content: retryPrompt },
      ],
      temperature,
      onProgress,
      config,
      maxTokens,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model: modelName, file: task.file, duration: Date.now() - startTime });
    return { success: false, output: '', error: msg };
  }

  const extractResult = extractCode(completion.text);

  if ('error' in extractResult) {
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model: modelName, file: task.file, duration: Date.now() - startTime });
    return { success: false, output: completion.text, error: extractResult.error, usage: completion.usage ?? undefined };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model: modelName, file: task.file, duration: Date.now() - startTime });
    return { success: false, output: completion.text, error: applyResult.error, usage: completion.usage ?? undefined };
  }

  const newContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const { diff, linesAdded, linesRemoved } = computeDiff(oldContent, newContent);
  onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'done', model: modelName, file: task.file, linesAdded, linesRemoved, diff, duration: Date.now() - startTime });

  return { success: true, output: completion.text, usage: completion.usage ?? undefined };
}
