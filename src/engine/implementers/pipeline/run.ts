import type {
  Implementer,
  ImplementerOptions,
  ImplementerPublisher,
  ImplementerResult,
  InvokeOpts,
  RetryOptions,
} from '../types.js';
import { composeSteeredPrompt } from '../../spec/prompts/steered-prompt.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import { toTokenDelta } from '../../calls/projection.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { formatErrorWithHint } from '../../error-hints.js';
import {
  formatImplementerSystemPreamble,
  formatTaskPrompt,
  formatRetryPrompt,
} from '../../spec/prompt-formatter.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { DEFAULT_AVAILABILITY } from '../../availability.js';
import { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import {
  captureChangeDetectorBaseline,
  type ChangeDetector,
  type ChangeDetectorBaseline,
} from '../../change-detection.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../../core/schemas/runner-fields.js';
import {
  ABORTED_OUTCOME_TEXT,
  createImplementerCallContext,
  defaultShouldThrow,
  errorOutput,
  runnerCallFailureMessage,
  runnerCallOutcome,
  typedRunnerCallErrorMessage,
} from './call-result.js';
import { processImplementerOutput, readTaskFileContent } from './extracted-code.js';
import { usageLimitDetailFromError } from '../../runners/usage-limit.js';
import { isAuthFailureDiagnostic } from '../../runners/auth-failure.js';
import { isRecord } from '../../../utils/type-guards.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';

const MAX_RETRY_TEMPERATURE = 2;

export interface ImplementerBaseConfig {
  extractsCode: boolean;
  backendKind?: RunnerCallContext['backendKind'] | undefined;
  prependSystemPreamble?: boolean;

  invoke(opts: InvokeOpts): Promise<RunnerCallResult>;
  buildPrompt?(opts: ImplementerOptions): string;
  buildRetryPrompt?(opts: RetryOptions): string;

  detectChanges?: ChangeDetector;
  retryTemperatureStep?: number;
  shouldThrow?(err: unknown): boolean;

  isAvailable?: () => Promise<boolean>;
  unavailabilityReason?: () => string | undefined;
  publisher?: ImplementerPublisher | undefined;
}

function retryTemperature(
  base: number | undefined,
  step: number | undefined,
  attempt: number,
): number | undefined {
  if (step == null) return undefined;
  return Math.min(
    (base ?? DEFAULT_IMPLEMENTER_TEMPERATURE) + step * attempt,
    MAX_RETRY_TEMPERATURE,
  );
}

export function createImplementerBase(baseConfig: ImplementerBaseConfig): Implementer {
  const shouldThrow = baseConfig.shouldThrow ?? defaultShouldThrow;
  const prependSystemPreamble = baseConfig.prependSystemPreamble !== false;
  const writesFiles = baseConfig.extractsCode ? 'extracted-code' : 'direct';
  const buildPrompt =
    baseConfig.buildPrompt ??
    ((opts: ImplementerOptions) =>
      formatTaskPrompt({
        task: opts.task,
        context: opts.context,
        contextLength: opts.config.implementer.contextLength,
        languageContext: opts.languageContext,
        writesFiles,
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
        writesFiles,
      }));

  async function runPipeline(
    opts: ImplementerOptions,
    rawPrompt: string,
    attempt: number,
    temperature?: number,
  ): Promise<ImplementerResult> {
    const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
    const systemPreamble = formatImplementerSystemPreamble(languageContext, writesFiles);
    const prompt =
      prependSystemPreamble && systemPreamble ? systemPreamble + '\n\n' + rawPrompt : rawPrompt;
    const { task, projectDir, config, onOutput, sessionId, phase } = opts;

    const failTask = () => {
      if (phase)
        baseConfig.publisher?.publishFailed({
          phase,
          taskId: task.id,
          ...(config.implementer.model !== undefined && { model: config.implementer.model }),
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
        kind: opts.changeDetection,
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
    const callContext = createImplementerCallContext({
      config,
      backendKind: baseConfig.backendKind,
      attempt,
    });

    let callResult: RunnerCallResult;
    try {
      const invokeResult = await baseConfig.invoke({
        callContext,
        prompt,
        task,
        projectDir,
        config,
        onOutput: wrappedOnOutput,
        systemPreamble,
        ...(temperature !== undefined && { temperature }),
        signal: opts.signal,
        onCallEvent: (event) => {
          if (phase) baseConfig.publisher?.publishCallEvent({ phase, taskId: task.id, event });
        },
        sandboxEnv: opts.sandboxEnv,
      });
      callResult = invokeResult;
    } catch (err) {
      if (opts.signal?.aborted) {
        implBuffer?.flushInterrupted();
        return { success: false, output: '', error: ABORTED_OUTCOME_TEXT };
      }
      if (shouldThrow(err)) throw err;
      const output = errorOutput(err);
      failTask();
      // API backends throw their provider errors instead of returning a
      // failed call result, so limits and dead credentials are classified
      // here too. The raw provider detail is kept over the rewritten hint:
      // the recovery needs the reset time the provider's own words carry.
      const limitDetail = usageLimitDetailFromError(err);
      if (limitDetail !== null) {
        return { success: false, output, error: limitDetail, outcome: 'usage-limit' };
      }
      const classification = typedRunnerCallErrorMessage(err) ?? toErrorMessage(err);
      const status = isRecord(err) && isRecord(err.data) ? err.data.status : undefined;
      if (status === 401 || isAuthFailureDiagnostic(classification)) {
        const rawDetail =
          typedRunnerCallErrorMessage(err) ??
          (isRecord(err) && isRecord(err.data) && typeof err.data.detail === 'string'
            ? err.data.detail
            : classification);
        return { success: false, output, error: rawDetail, outcome: 'unauthenticated' };
      }
      return {
        success: false,
        output,
        error: formatErrorWithHint(classification),
      };
    }

    const usage = toTokenDelta(callResult.usage);
    const usageField = usage !== null ? { usage } : {};
    const outputText = callResult.text;

    if (callResult.status !== 'completed') {
      if (callResult.status === 'aborted' && opts.signal?.aborted) {
        implBuffer?.flushInterrupted();
      } else {
        implBuffer?.flush();
        failTask();
      }
      const outcome = runnerCallOutcome(callResult);
      return {
        success: false,
        output: outputText,
        error: runnerCallFailureMessage(callResult, opts.signal),
        ...(outcome.state !== 'success' && { outcome: outcome.state }),
        ...usageField,
      };
    }

    implBuffer?.flush();

    try {
      if (baseConfig.extractsCode) {
        const result = await processImplementerOutput({
          text: outputText,
          task,
          projectDir,
          approvedBaselineContent: oldContent,
          approveWrite: opts.approveWrite,
        });
        if (!result.success) {
          failTask();
          return { success: false, output: outputText, error: result.error, ...usageField };
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
        return { success: true, output: outputText, ...usageField };
      }

      if (baseConfig.detectChanges && changeBaseline) {
        const changes = await baseConfig.detectChanges(projectDir, changeBaseline);
        if (!changes.changed) {
          if (phase) {
            baseConfig.publisher?.publishWarning({
              phase,
              taskId: task.id,
              message: `Implementer ${getRunnerDisplayName(config.implementer)} wrote nothing for task ${task.id}: ${changes.output}`,
              safety: {
                category: 'implementer',
                code: 'implementer_wrote_nothing',
                transcriptSafe: true,
              },
            });
          }
          failTask();
          return {
            success: false,
            output: outputText,
            error: changes.output,
            outcome: 'no-staged-change',
            ...usageField,
          };
        }
      }
    } catch (err) {
      failTask();
      return {
        success: false,
        output: outputText,
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
    return { success: true, output: outputText, ...usageField };
  }

  return {
    async implement(opts: ImplementerOptions): Promise<ImplementerResult> {
      const prompt = composeSteeredPrompt(opts.continuationPrompt ?? buildPrompt(opts), opts.steer);
      return runPipeline(opts, prompt, 0);
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
      return runPipeline(opts, prompt, opts.attempt, temperature);
    },

    ...DEFAULT_AVAILABILITY,
    capabilities: { writesFiles },
    ...(baseConfig.isAvailable && { isAvailable: baseConfig.isAvailable }),
    ...(baseConfig.unavailabilityReason && {
      unavailabilityReason: baseConfig.unavailabilityReason,
    }),
  };
}
