import { CommandNotFoundError, CommandTimeoutError, createProcessError, type SpawnResult } from '../../utils/process.js';
import { getChangedFiles } from '../../utils/git.js';
import type { ImplementerOptions } from './types.js';

export const DEFAULT_TIMEOUT = 300_000;

export function assertSpawnSuccess(
  result: SpawnResult,
  opts: { label: string; timeoutMs: number; notFoundMessage: string },
): void {
  if (result.code === 127) {
    throw new CommandNotFoundError(opts.notFoundMessage);
  }
  if (result.timedOut) {
    throw new CommandTimeoutError(
      `${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
      result.output,
    );
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw createProcessError(
      `${opts.label} exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
      result.output,
    );
  }
}

export function createChangeDetector(label: string) {
  return async (projectDir: string) => {
    const changedFiles = await getChangedFiles(projectDir);
    if (changedFiles.length === 0) {
      return { changed: false, output: `${label} exited without changing any files` };
    }
    return { changed: true, output: '' };
  };
}

export interface InvokeOpts {
  prompt: string;
  task: ImplementerOptions['task'];
  projectDir: string;
  config: ImplementerOptions['config'];
  onOutput: (text: string) => void;
  temperature?: number;
}

function hasOutput(err: unknown): err is { output: string } {
  return typeof err === 'object' && err !== null && 'output' in err && typeof (err as { output: unknown }).output === 'string';
}

export function extractOutput(err: unknown): string {
  return hasOutput(err) ? err.output : '';
}

const MAX_TEMPERATURE = 2;

export function retryTemperature(base: number, step: number | undefined, attempt: number): number | undefined {
  if (step == null) return undefined;
  return Math.min(base + step * attempt, MAX_TEMPERATURE);
}
