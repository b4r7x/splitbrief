import type {
  Implementer,
  ImplementerOptions,
  ImplementerPublisher,
  ImplementerResult,
  InvokeOpts,
  RetryOptions,
} from './types.js';
import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import { confinedExists, confinedReadFileAsync } from '../../lib/confined-fs.js';
import { assertPathConfined, pathConfinementError } from '../../lib/path-confinement.js';
import { matches } from '../../utils/error.js';

const isPathEscape = matches('path-confined-escape');

async function readTaskFileContent(projectDir: string, file: string): Promise<string | null> {
  try {
    if (!confinedExists(projectDir, file)) return null;
    return await confinedReadFileAsync(projectDir, file);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) return null;
    throw err;
  }
}
import { toErrorMessage } from '../../utils/format-errors.js';
import { formatErrorWithHint } from '../error-hints.js';
import { extractCode } from '../parsers/response-extractor.js';
import { applyCode } from './apply.js';
import { computeDiff } from '../../utils/diff.js';
import { formatTaskPrompt, formatRetryPrompt } from '../spec/prompt-formatter.js';
import { buildLanguageContext } from '../spec/prompts/language-context.js';
import { buildSystemPreamble } from '../spec/prompts/system.js';
import { processError } from '../../lib/process/errors.js';
import { DEFAULT_AVAILABILITY } from '../availability.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  captureChangeDetectorBaseline,
  type ChangeDetector,
  type ChangeDetectorBaseline,
} from '../change-detection.js';

const MAX_RETRY_TEMPERATURE = 2;
const DEFAULT_RETRY_TEMPERATURE = 0.7;

export function extractedCodeApprovalRaceError(file: string): string {
  return `write blocked because ${file} changed during approval`;
}

export function isExtractedCodeApprovalRaceError(file: string, error?: string): boolean {
  return error === extractedCodeApprovalRaceError(file);
}

async function processImplementerOutput(opts: {
  text: string;
  task: Task;
  projectDir: string;
  approvedBaselineContent: string | null;
  approveWrite?:
    | ((file: string) => Promise<{ allow: boolean; reason?: string | undefined }>)
    | undefined;
}): Promise<
  | { success: true; diff: string; linesAdded: number; linesRemoved: number }
  | { success: false; error: string }
> {
  const { text, task, projectDir, approvedBaselineContent, approveWrite } = opts;
  const extractResult = extractCode(text);

  if ('error' in extractResult) {
    return { success: false, error: extractResult.error };
  }

  const approval = approveWrite ? await approveWrite(task.file) : { allow: true };
  if (!approval.allow) {
    return { success: false, error: approval.reason ?? 'write denied by approval gate' };
  }

  const currentContent = await readTaskFileContent(projectDir, task.file);
  if (currentContent !== approvedBaselineContent) {
    return {
      success: false,
      error: extractedCodeApprovalRaceError(task.file),
    };
  }

  const applyResult = await applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, error: applyResult.error ?? 'Failed to apply code' };
  }

  const newContent = (await readTaskFileContent(projectDir, task.file)) ?? '';
  const { diff, linesAdded, linesRemoved } = computeDiff(approvedBaselineContent ?? '', newContent);

  return { success: true, diff, linesAdded, linesRemoved };
}

export interface ImplementerBaseConfig {
  extractsCode: boolean;
  /**
   * If false, the backend handles buildSystemPreamble() separately (e.g., as a system message).
   * If true or undefined (default), runPipeline prepends buildSystemPreamble() to the prompt.
   */
  prependSystemPreamble?: boolean;

  invoke(opts: InvokeOpts): Promise<InvokeResult>;
  buildPrompt?(opts: ImplementerOptions): string;
  buildRetryPrompt?(opts: RetryOptions): string;

  detectChanges?: ChangeDetector;
  retryTemperatureStep?: number;
  shouldThrow?(err: unknown): boolean;

  isAvailable?: () => Promise<boolean>;
  publisher?: ImplementerPublisher | undefined;
}

function defaultShouldThrow(err: unknown): boolean {
  return processError.isNotFound(err) || processError.isTimeout(err);
}

function retryTemperature(
  base: number | undefined,
  step: number | undefined,
  attempt: number,
): number | undefined {
  if (step == null) return undefined;
  return Math.min((base ?? DEFAULT_RETRY_TEMPERATURE) + step * attempt, MAX_RETRY_TEMPERATURE);
}

export function createImplementerBase(baseConfig: ImplementerBaseConfig): Implementer {
  const shouldThrow = baseConfig.shouldThrow ?? defaultShouldThrow;
  const prependSystemPreamble = baseConfig.prependSystemPreamble !== false;
  const buildPrompt =
    baseConfig.buildPrompt ??
    ((opts: ImplementerOptions) =>
      formatTaskPrompt({
        task: opts.task,
        context: opts.context,
        contextLength: opts.config.implementer.contextLength,
        languageContext: opts.languageContext,
      }));
  const buildRetryPrompt =
    baseConfig.buildRetryPrompt ??
    ((opts: RetryOptions) =>
      formatRetryPrompt({
        task: opts.task,
        context: opts.context,
        error: opts.error,
        attempt: opts.attempt,
        contextLength: opts.config.implementer.contextLength,
        languageContext: opts.languageContext,
      }));

  async function runPipeline(
    opts: ImplementerOptions,
    rawPrompt: string,
    temperature?: number,
  ): Promise<ImplementerResult> {
    const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
    const systemPreamble = buildSystemPreamble(languageContext);
    const prompt = prependSystemPreamble ? systemPreamble + '\n\n' + rawPrompt : rawPrompt;
    const { task, projectDir, config, onOutput, sessionId, phase } = opts;

    const failTask = () => {
      if (phase)
        baseConfig.publisher?.publishFailed({
          phase,
          taskId: task.id,
          model: config.implementer.model,
        });
    };

    assertPathConfined(task.file, projectDir);

    let oldContent: string | null = null;
    if (baseConfig.extractsCode) {
      oldContent = await readTaskFileContent(projectDir, task.file);
    }

    let changeBaseline: ChangeDetectorBaseline | undefined;
    if (!baseConfig.extractsCode && baseConfig.detectChanges) {
      changeBaseline = await captureChangeDetectorBaseline(projectDir, {
        ignoreProjectDir: opts.fileIgnoreProjectDir,
      });
    }

    const persistTranscript = config.workflow.persistTranscript;
    const implBuffer = sessionId
      ? createTranscriptBuffer({
          projectDir,
          sessionId,
          phase: 'implementing',
          persistTranscript,
        })
      : null;
    const wrappedOnOutput = baseConfig.extractsCode
      ? (text: string) => {
          onOutput(text);
          implBuffer?.append(text);
        }
      : onOutput;

    if (phase) baseConfig.publisher?.publishRunning({ phase, taskId: task.id, file: task.file });
    const startTime = Date.now();

    let invokeResult: InvokeResult;
    try {
      invokeResult = await baseConfig.invoke({
        prompt,
        task,
        projectDir,
        config,
        onOutput: wrappedOnOutput,
        systemPreamble,
        ...(temperature !== undefined && { temperature }),
        signal: opts.signal,
        sandboxEnv: opts.sandboxEnv,
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        implBuffer?.flushInterrupted();
        return { success: false, output: '', error: 'Aborted' };
      }
      if (shouldThrow(err)) throw err;
      const output = isRecord(err) && typeof err.output === 'string' ? err.output : '';
      failTask();
      return { success: false, output, error: formatErrorWithHint(toErrorMessage(err)) };
    }

    implBuffer?.flush();

    const usageField = invokeResult.usage ? { usage: invokeResult.usage } : {};

    try {
      if (baseConfig.extractsCode) {
        const result = await processImplementerOutput({
          text: invokeResult.text,
          task,
          projectDir,
          approvedBaselineContent: oldContent,
          approveWrite: opts.approveWrite,
        });
        if (!result.success) {
          failTask();
          return { success: false, output: invokeResult.text, error: result.error, ...usageField };
        }
        if (phase) {
          baseConfig.publisher?.publishDone({
            phase,
            taskId: task.id,
            file: task.file,
            diff: result.diff,
            linesAdded: result.linesAdded,
            linesRemoved: result.linesRemoved,
            duration: Date.now() - startTime,
          });
        }
        return { success: true, output: invokeResult.text, ...usageField };
      }

      if (baseConfig.detectChanges && changeBaseline) {
        const changes = await baseConfig.detectChanges(projectDir, changeBaseline);
        if (!changes.changed) {
          failTask();
          return {
            success: false,
            output: invokeResult.text,
            error: changes.output,
            ...usageField,
          };
        }
      }
    } catch (err) {
      failTask();
      return {
        success: false,
        output: invokeResult.text,
        error: toErrorMessage(err),
        ...usageField,
      };
    }

    if (phase) {
      baseConfig.publisher?.publishDone({
        phase,
        taskId: task.id,
        file: task.file,
        linesAdded: 0,
        linesRemoved: 0,
        duration: Date.now() - startTime,
      });
    }
    return { success: true, output: invokeResult.text, ...usageField };
  }

  return {
    async implement(opts: ImplementerOptions): Promise<ImplementerResult> {
      const prompt = opts.continuationPrompt ?? buildPrompt(opts);
      return runPipeline(opts, prompt);
    },

    async retry(opts: RetryOptions): Promise<ImplementerResult> {
      const prompt = buildRetryPrompt(opts);
      const temperature =
        opts.kind === 'hint'
          ? opts.config.implementer.temperature
          : retryTemperature(
              opts.config.implementer.temperature,
              baseConfig.retryTemperatureStep,
              opts.attempt,
            );
      return runPipeline(opts, prompt, temperature);
    },

    ...DEFAULT_AVAILABILITY,
    capabilities: { writesFiles: baseConfig.extractsCode ? 'extracted-code' : 'direct' },
    ...(baseConfig.isAvailable && { isAvailable: baseConfig.isAvailable }),
  };
}
