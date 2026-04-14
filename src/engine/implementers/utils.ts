import { CommandNotFoundError, CommandTimeoutError, createProcessError } from '../../utils/process-errors.js';
import type { SpawnResult } from '../../utils/process.js';
import type {
  AgentImplementerConfig,
  AgentSdkImplementerConfig,
  ApiImplementerConfig,
  Config,
  ShellImplementerConfig,
} from '../../types.js';
import type { ImplementerOptions } from './types.js';

export { createChangeDetector } from '../change-detection.js';
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


export function assertImplementerKind(config: Config, kind: 'api'): ApiImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'shell'): ShellImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'agent'): AgentImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'agent-sdk'): AgentSdkImplementerConfig;
export function assertImplementerKind(
  config: Config,
  kind: Config['implementer']['kind'],
): Config['implementer'] {
  if (config.implementer.kind !== kind) {
    throw new Error(`Expected ${kind} implementer config`);
  }
  return config.implementer;
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
  return typeof err === 'object' && err !== null && 'output' in err && typeof err.output === 'string';
}

export function extractOutput(err: unknown): string {
  return hasOutput(err) ? err.output : '';
}

const MAX_TEMPERATURE = 2;
const DEFAULT_TEMPERATURE = 0.7;

export function retryTemperature(base: number | undefined, step: number | undefined, attempt: number): number | undefined {
  if (step == null) return undefined;
  return Math.min((base ?? DEFAULT_TEMPERATURE) + step * attempt, MAX_TEMPERATURE);
}
