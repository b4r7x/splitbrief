import { join } from 'node:path';
import type { Implementer, ImplementerOptions, RetryOptions } from './types.js';
import type { Task, TuiEvent, ImplementerResult, ImplementerTokenUsage } from '../../types.js';
import type { PricingInfo } from '../../core/providers/pricing.js';
import { readFileOrEmpty } from '../../utils/fs.js';
import { getImplementerPricing } from '../../core/providers/pricing.js';
import { toErrorMessage } from '../../utils/format.js';
import { getChangedFiles } from '../../utils/git.js';
import { extractCode } from '../parsers/response-extractor.js';
import { applyCode } from '../orchestrator/apply.js';
import { computeDiff } from '../../utils/diff.js';
import { buildFullPrompt, buildFullRetryPrompt } from '../spec/formatter.js';

export const DEFAULT_TIMEOUT = 300_000;

export interface InvokeResult {
  text: string;
  usage?: ImplementerTokenUsage | null;
}

type GenEventEmitter = (status: 'running' | 'done' | 'failed', extra?: Record<string, unknown>) => void;

function createGenEventEmitter(
  onEvent: ((event: TuiEvent) => void) | undefined,
  model: string,
  file: string,
): GenEventEmitter {
  const startTime = Date.now();
  return (status, extra) => {
    if (status === 'running') {
      onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'running', file });
    } else if (status === 'done') {
      onEvent?.({
        type: 'implementer-generate',
        ts: Date.now(),
        status: 'done',
        file,
        duration: Date.now() - startTime,
        linesAdded: (extra?.linesAdded as number) ?? 0,
        linesRemoved: (extra?.linesRemoved as number) ?? 0,
        diff: extra?.diff as string | undefined,
      });
    } else {
      onEvent?.({ type: 'implementer-generate', ts: Date.now(), status: 'failed', model });
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
    return { success: false, error: applyResult.error! };
  }

  const filePath = join(projectDir, task.file);
  const newContent = readFileOrEmpty(filePath);
  const { diff, linesAdded, linesRemoved } = computeDiff(oldContent, newContent);

  return { success: true, diff, linesAdded, linesRemoved };
}

function defaultBuildPrompt(opts: ImplementerOptions): string {
  return buildFullPrompt(opts.task, opts.context, opts.config.implementer.contextLength);
}

function defaultBuildRetryPrompt(opts: RetryOptions): string {
  return buildFullRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength);
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
  onProgress: (text: string) => void;
  temperature?: number;
}

export interface ImplementerBaseConfig {
  name: string;
  pricingKey: string;
  extractsCode: boolean;

  invoke(opts: InvokeOpts): Promise<InvokeResult>;
  buildPrompt?(opts: ImplementerOptions): string;
  buildRetryPrompt?(opts: RetryOptions): string;

  isAvailable(): Promise<boolean>;

  detectChanges?(projectDir: string): Promise<{ changed: boolean; output: string }>;
  retryTemperatureStep?: number;
  shouldThrow?(err: unknown): boolean;
}

function hasStringProp<K extends string>(val: unknown, key: K): val is Record<K, string> {
  return typeof val === 'object' && val !== null && key in val && typeof (val as Record<string, unknown>)[key] === 'string';
}

const MAX_TEMPERATURE = 2;

function retryTemperature(base: number, step: number | undefined, attempt: number): number | undefined {
  if (step == null) return undefined;
  return Math.min(base + step * attempt, MAX_TEMPERATURE);
}

export function createImplementerBase(config: ImplementerBaseConfig): Implementer {
  const buildPrompt = config.buildPrompt ?? defaultBuildPrompt;
  const buildRetryPrompt = config.buildRetryPrompt ?? defaultBuildRetryPrompt;

  async function runPipeline(
    opts: ImplementerOptions,
    prompt: string,
    temperature?: number,
  ): Promise<ImplementerResult> {
    const { task, projectDir, config: cfg, onProgress, onEvent } = opts;
    const emitGenEvent = createGenEventEmitter(onEvent, cfg.implementer.model, task.file);

    emitGenEvent('running');

    const oldContent = config.extractsCode
      ? readFileOrEmpty(join(projectDir, task.file))
      : '';

    let implResult: ImplementerResult | undefined;
    try {
      let invokeResult: InvokeResult;
      try {
        invokeResult = await config.invoke({ prompt, task, projectDir, config: cfg, onProgress, temperature });
      } catch (err) {
        if (config.shouldThrow?.(err)) throw err;
        const output = hasStringProp(err, 'output') ? err.output : '';
        return { success: false, output, error: toErrorMessage(err) };
      }

      const usage = invokeResult.usage ?? null;

      if (config.extractsCode) {
        const result = await processImplementerOutput(invokeResult.text, task, projectDir, oldContent);
        if (!result.success) {
          return { success: false, output: invokeResult.text, error: result.error, usage: usage ?? undefined };
        }
        emitGenEvent('done', { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved, diff: result.diff });
        implResult = { success: true, output: invokeResult.text, usage: usage ?? undefined };
        return implResult;
      }

      if (config.detectChanges) {
        const changes = await config.detectChanges(projectDir);
        if (!changes.changed) {
          return { success: false, output: invokeResult.text, error: changes.output };
        }
      }

      emitGenEvent('done');
      implResult = { success: true, output: invokeResult.text, usage: usage ?? undefined };
      return implResult;
    } finally {
      if (!implResult?.success) emitGenEvent('failed');
    }
  }

  return {
    name: config.name,

    async implement(opts: ImplementerOptions): Promise<ImplementerResult> {
      const prompt = buildPrompt(opts);
      return runPipeline(opts, prompt);
    },

    async retry(opts: RetryOptions): Promise<ImplementerResult> {
      const prompt = buildRetryPrompt(opts);
      const temperature = retryTemperature(opts.config.implementer.temperature, config.retryTemperatureStep, opts.attempt);
      return runPipeline(opts, prompt, temperature);
    },

    async isAvailable(): Promise<boolean> {
      return config.isAvailable();
    },

    getPricing(): PricingInfo {
      return getImplementerPricing(config.pricingKey);
    },
  };
}
