import { join } from 'node:path';
import type { Task, Config, ProjectContext, TuiEvent, ImplementerResult } from '../types.js';
import { extractCode } from './extractor.js';
import { applyCode } from './apply.js';
import { computeDiff } from '../utils/diff.js';
import { readFileOrEmpty } from '../utils/fs.js';

export interface ImplementerOptions {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onProgress: (text: string) => void;
  onEvent?: (event: TuiEvent) => void;
}

export interface RetryOptions extends ImplementerOptions {
  error: string;
  attempt: number;
}

export interface ImplementerHandler {
  implement: (opts: ImplementerOptions) => Promise<ImplementerResult>;
  retry: (opts: RetryOptions) => Promise<ImplementerResult>;
}

type GenEventEmitter = (status: 'running' | 'done' | 'failed', extra?: Record<string, unknown>) => void;

export function createGenEventEmitter(
  onEvent: ((event: TuiEvent) => void) | undefined,
  model: string,
  file: string,
): GenEventEmitter {
  const startTime = Date.now();
  return (status, extra) => {
    onEvent?.({ type: 'implementer-generate', ts: Date.now(), model, file, duration: Date.now() - startTime, status, ...extra });
  };
}

export async function processImplementerOutput(
  text: string,
  task: Task,
  projectDir: string,
  oldContent: string,
): Promise<{ success: true; diff: string; linesAdded: number; linesRemoved: number } | { success: false; error: string }> {
  const extractResult = extractCode(text);

  if ('error' in extractResult) {
    return { success: false, error: extractResult.error };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, error: applyResult.error! };
  }

  const filePath = join(projectDir, task.file);
  const newContent = readFileOrEmpty(filePath);
  const { diff, linesAdded, linesRemoved } = computeDiff(oldContent, newContent);

  return { success: true, diff, linesAdded, linesRemoved };
}
