import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Task, Config, ProjectContext } from '../types.js';
import { createClient } from './providers.js';
import { formatTaskPrompt, formatRetryPrompt } from '../spec/formatter.js';
import { extractCode } from './extractor.js';

function applyCode(code: string, task: Task, projectDir: string): { success: boolean; error?: string } {
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

async function streamCompletion(
  client: ReturnType<typeof createClient>,
  model: string,
  prompt: string,
  temperature: number,
  onProgress: (text: string) => void,
  config: Config,
): Promise<string> {
  let stream;
  try {
    stream = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      stream: true,
    });
  } catch (err: any) {
    if (err?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNREFUSED') {
      const baseURL = config.implementer.apiBase || `${config.implementer.provider} default`;
      throw new Error(
        `Cannot connect to ${config.implementer.provider} at ${baseURL}. Is it running?`,
      );
    }
    if (err?.status && err.status >= 400) {
      throw new Error(
        `API error ${err.status} from ${config.implementer.provider}: ${err.message ?? 'Unknown error'}`,
      );
    }
    throw err;
  }

  let fullResponse = '';
  const timeout = 60_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Model response timed out after 60 seconds')), timeout),
  );

  try {
    await Promise.race([
      (async () => {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            onProgress(content);
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err: any) {
    if (err?.message === 'Model response timed out after 60 seconds') {
      throw err;
    }
    if (err?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNREFUSED') {
      const baseURL = config.implementer.apiBase || `${config.implementer.provider} default`;
      throw new Error(
        `Cannot connect to ${config.implementer.provider} at ${baseURL}. Is it running?`,
      );
    }
    if (err?.status && err.status >= 400) {
      throw new Error(
        `API error ${err.status} from ${config.implementer.provider}: ${err.message ?? 'Unknown error'}`,
      );
    }
    throw err;
  }

  return fullResponse;
}

export async function implementTask(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string }> {
  const prompt = formatTaskPrompt(task, context);
  const client = createClient(config);

  let fullResponse: string;
  try {
    fullResponse = await streamCompletion(
      client,
      config.implementer.model,
      prompt,
      config.implementer.temperature,
      onProgress,
      config,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }

  const extractResult = extractCode(fullResponse);

  if ('error' in extractResult) {
    return { success: false, output: fullResponse, error: extractResult.error };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, output: fullResponse, error: applyResult.error };
  }

  return { success: true, output: fullResponse };
}

export async function retryTask(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  error: string,
  attempt: number,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string }> {
  const prompt = formatRetryPrompt(task, context, error, attempt);
  const client = createClient(config);
  const temperature = Math.min(config.implementer.temperature + attempt * 0.1, 2);

  let fullResponse: string;
  try {
    fullResponse = await streamCompletion(
      client,
      config.implementer.model,
      prompt,
      temperature,
      onProgress,
      config,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }

  const extractResult = extractCode(fullResponse);

  if ('error' in extractResult) {
    return { success: false, output: fullResponse, error: extractResult.error };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, output: fullResponse, error: applyResult.error };
  }

  return { success: true, output: fullResponse };
}
