import { join } from 'node:path';
import type { Implementer, ImplementerOptions, RetryOptions } from './types.js';
import type { Task, TuiEvent, ImplementerResult, InvokeResult } from '../../types.js';
import { readFileOrEmpty } from '../../utils/fs.js';
import { toErrorMessage } from '../../utils/format.js';
import { formatErrorWithHint } from '../../utils/error-hints.js';
import { extractCode } from '../parsers/response-extractor.js';
import { applyCode } from './apply.js';
import { computeDiff } from '../../utils/diff.js';
import { SYSTEM_PREAMBLE, formatTaskPrompt, formatRetryPrompt } from '../spec/formatter.js';
import { CommandNotFoundError } from '../../utils/process.js';
import { extractOutput, retryTemperature, type InvokeOpts } from './utils.js';
import { DEFAULT_AVAILABILITY } from '../../utils/availability.js';

type GenEventEmitter = (status: 'running' | 'done' | 'failed', extra?: Record<string, unknown>) => void;

function createGenEventEmitter(
  onEvent: ((event: TuiEvent) => void) | undefined,
  model: string,
  file: string,
): GenEventEmitter {
  const startTime = Date.now();
  return (status, extra) => {
    if (status === 'running') {
      onEvent?.({ type: 'implementer-generate-running', ts: Date.now(), file });
    } else if (status === 'done') {
      const diff = typeof extra?.diff === 'string' ? extra.diff : undefined;
      onEvent?.({
        type: 'implementer-generate-done',
        ts: Date.now(),
        file,
        duration: Date.now() - startTime,
        linesAdded: typeof extra?.linesAdded === 'number' ? extra.linesAdded : 0,
        linesRemoved: typeof extra?.linesRemoved === 'number' ? extra.linesRemoved : 0,
        ...(diff !== undefined && { diff }),
      });
    } else {
      onEvent?.({ type: 'implementer-generate-failed', ts: Date.now(), model });
    }
  };
}

async function processImplementerOutput(
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
    return { success: false, error: applyResult.error ?? 'Failed to apply code' };
  }

  const filePath = join(projectDir, task.file);
  const newContent = await readFileOrEmpty(filePath);
  const { diff, linesAdded, linesRemoved } = computeDiff(oldContent, newContent);

  return { success: true, diff, linesAdded, linesRemoved };
}

export interface ImplementerBaseConfig {
  extractsCode: boolean;
  /**
   * If false, the backend handles SYSTEM_PREAMBLE separately (e.g., as a system message).
   * If true or undefined (default), runPipeline prepends SYSTEM_PREAMBLE to the prompt.
   */
  prependSystemPreamble?: boolean;

  invoke(opts: InvokeOpts): Promise<InvokeResult>;
  buildPrompt?(opts: ImplementerOptions): string;
  buildRetryPrompt?(opts: RetryOptions): string;

  detectChanges?(projectDir: string): Promise<{ changed: boolean; output: string }>;
  retryTemperatureStep?: number;
  shouldThrow?(err: unknown): boolean;

  isAvailable?: () => Promise<boolean>;
  getVersion?: () => Promise<string | null>;
}

function defaultShouldThrow(err: unknown): boolean {
  return err instanceof CommandNotFoundError;
}

export function createImplementerBase(baseConfig: ImplementerBaseConfig): Implementer {
  const shouldThrow = baseConfig.shouldThrow ?? defaultShouldThrow;
  const prependSystemPreamble = baseConfig.prependSystemPreamble !== false;
  const buildPrompt = baseConfig.buildPrompt ?? ((opts: ImplementerOptions) =>
    formatTaskPrompt(opts.task, opts.context, opts.config.implementer.contextLength));
  const buildRetryPrompt = baseConfig.buildRetryPrompt ?? ((opts: RetryOptions) =>
    formatRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength));

  async function runPipeline(
    opts: ImplementerOptions,
    rawPrompt: string,
    temperature?: number,
  ): Promise<ImplementerResult> {
    const prompt = prependSystemPreamble ? SYSTEM_PREAMBLE + '\n\n' + rawPrompt : rawPrompt;
    const { task, projectDir, config, onOutput, onEvent } = opts;
    const emitGenEvent = createGenEventEmitter(onEvent, config.implementer.model, task.file);

    emitGenEvent('running');

    let oldContent = '';
    if (baseConfig.extractsCode) {
      oldContent = await readFileOrEmpty(join(projectDir, task.file));
    }

    let invokeResult: InvokeResult;
    try {
      invokeResult = await baseConfig.invoke({
        prompt, task, projectDir, config, onOutput,
        ...(temperature !== undefined && { temperature }),
      });
    } catch (err) {
      emitGenEvent('failed');
      if (shouldThrow(err)) throw err;
      return { success: false, output: extractOutput(err), error: formatErrorWithHint(toErrorMessage(err)) };
    }

    const usageField = invokeResult.usage ? { usage: invokeResult.usage } : {};

    try {
      if (baseConfig.extractsCode) {
        const result = await processImplementerOutput(invokeResult.text, task, projectDir, oldContent);
        if (!result.success) {
          emitGenEvent('failed');
          return { success: false, output: invokeResult.text, error: result.error, ...usageField };
        }
        emitGenEvent('done', { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved, diff: result.diff });
        return { success: true, output: invokeResult.text, ...usageField };
      }

      if (baseConfig.detectChanges) {
        const changes = await baseConfig.detectChanges(projectDir);
        if (!changes.changed) {
          emitGenEvent('failed');
          return { success: false, output: invokeResult.text, error: changes.output };
        }
      }
    } catch (err) {
      emitGenEvent('failed');
      return { success: false, output: invokeResult.text, error: toErrorMessage(err), ...usageField };
    }

    emitGenEvent('done');
    return { success: true, output: invokeResult.text, ...usageField };
  }

  return {
    async implement(opts: ImplementerOptions): Promise<ImplementerResult> {
      const prompt = buildPrompt(opts);
      return runPipeline(opts, prompt);
    },

    async retry(opts: RetryOptions): Promise<ImplementerResult> {
      const prompt = buildRetryPrompt(opts);
      const temperature = opts.kind === 'hint'
        ? opts.config.implementer.temperature
        : retryTemperature(opts.config.implementer.temperature, baseConfig.retryTemperatureStep, opts.attempt);
      return runPipeline(opts, prompt, temperature);
    },

    ...DEFAULT_AVAILABILITY,
    ...(baseConfig.isAvailable && { isAvailable: baseConfig.isAvailable }),
    ...(baseConfig.getVersion && { getVersion: baseConfig.getVersion }),
  };
}
