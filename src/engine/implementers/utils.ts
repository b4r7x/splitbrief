import { processError } from '../../lib/process/errors.js';
import type { SpawnResult } from '../../lib/process/spawn.js';
import type { ImplementerOptions } from './types.js';

export { IMPLEMENTER_TIMEOUT_MS as DEFAULT_TIMEOUT } from '../constants.js';

export function assertSpawnSuccess(
  result: SpawnResult,
  opts: { label: string; timeoutMs: number; notFoundMessage: string },
): void {
  if (result.code === 127) {
    throw processError.notFound(opts.label, opts.notFoundMessage);
  }
  if (result.timedOut) {
    throw processError.timeout({
      command: opts.label,
      label: opts.label,
      timeoutMs: opts.timeoutMs,
      output: result.output,
    });
  }
  if (result.code !== 0) {
    throw processError.exitCode({
      command: opts.label,
      label: opts.label,
      code: result.code,
      stderr: result.stderr,
      output: result.output,
    });
  }
}


export { assertImplementerKind } from '../config-assertions.js';

export interface InvokeOpts {
  prompt: string;
  task: ImplementerOptions['task'];
  projectDir: string;
  config: ImplementerOptions['config'];
  onOutput: (text: string) => void;
  systemPreamble: string;
  temperature?: number;
  signal?: AbortSignal | undefined;
}

const MAX_TEMPERATURE = 2;
const DEFAULT_TEMPERATURE = 0.7;

export function retryTemperature(base: number | undefined, step: number | undefined, attempt: number): number | undefined {
  if (step == null) return undefined;
  return Math.min((base ?? DEFAULT_TEMPERATURE) + step * attempt, MAX_TEMPERATURE);
}
