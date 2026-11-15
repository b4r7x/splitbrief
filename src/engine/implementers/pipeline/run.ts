import type {
  Implementer,
  ImplementerOptions,
  ImplementerPublisher,
  ImplementerResult,
  InvokeOpts,
  RetryOptions,
} from '../types.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import { selectBuildOutputContract, type BuildOutputContract } from '../file-bundle/contract.js';
import { DEFAULT_AVAILABILITY } from '../../availability.js';
import type { ChangeDetector } from '../../change-detection.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../../core/schemas/runner/fields.js';
import type { ImplementerWriteMode } from '../../../core/schemas/runner/implementer.js';
import { defaultShouldThrow } from './call-result.js';
import { retryPrompt, taskPrompt } from './prompt.js';
import { prepareCall } from './bundle-io.js';
import { runPipeline } from './attempt.js';

const MAX_RETRY_TEMPERATURE = 2;

export interface ImplementerBaseConfig {
  extractsCode: boolean;
  backendKind?: RunnerCallContext['backendKind'] | undefined;
  /**
   * The BUILD grammar this backend is prompted for and parsed with. Absent
   * keeps what the backend kind selects, so an extracted-code writer stays on
   * the legacy code grammar and a direct writer stays direct.
   */
  outputContract?: BuildOutputContract | undefined;
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
  const writesFiles: ImplementerWriteMode = baseConfig.extractsCode ? 'extracted-code' : 'direct';
  const outputContract = baseConfig.outputContract ?? selectBuildOutputContract(baseConfig);
  /**
   * What this seat's own attempts actually created for a task. A retry after a
   * partial application rewrites the file it made instead of refusing to create
   * it twice. In-process only: a crash leaves no record here, and the capture
   * then parks the brief for recovery rather than assuming ownership.
   */
  const createdByTask = new Map<string, Set<string>>();
  const seat = {
    outputContract,
    publisher: baseConfig.publisher,
    createdByTask,
    failTask,
    detectChanges: baseConfig.detectChanges,
    writesFiles,
    prependSystemPreamble,
    shouldThrow,
    backendKind: baseConfig.backendKind,
    invoke: baseConfig.invoke,
  };
  const buildPrompt =
    baseConfig.buildPrompt ??
    ((opts: ImplementerOptions) => taskPrompt(opts, writesFiles, outputContract));
  const buildRetryPrompt =
    baseConfig.buildRetryPrompt ??
    ((opts: RetryOptions) => retryPrompt(opts, writesFiles, outputContract));

  function failTask(opts: ImplementerOptions, error: string): void {
    if (!opts.phase) return;
    baseConfig.publisher?.publishFailed({
      phase: opts.phase,
      taskId: opts.task.id,
      error,
      ...(opts.config.implementer.model !== undefined && { model: opts.config.implementer.model }),
    });
  }

  return {
    async implement(opts: ImplementerOptions): Promise<ImplementerResult> {
      const prepared = await prepareCall(seat, opts);
      if (prepared.kind === 'refused') return prepared.result;
      // A restarted brief is the same brief: the prompt is the brief's own, with
      // the cut attempt's partial and the files it already wrote trailing it.
      const base = buildPrompt(prepared.opts);
      const prompt =
        prepared.opts.continuation === undefined
          ? base
          : composeContinuation({ basePrompt: base, ...prepared.opts.continuation });
      return runPipeline(seat, prepared.opts, prompt, 0, undefined, prepared.baselines);
    },

    async retry(opts: RetryOptions): Promise<ImplementerResult> {
      const prepared = await prepareCall(seat, opts);
      if (prepared.kind === 'refused') return prepared.result;
      const retryOpts: RetryOptions = { ...opts, task: prepared.opts.task };
      const base = buildRetryPrompt(retryOpts);
      const prompt =
        retryOpts.continuation === undefined
          ? base
          : composeContinuation({ basePrompt: base, ...retryOpts.continuation });
      const temperature =
        retryOpts.kind === 'consult'
          ? retryOpts.config.implementer.temperature
          : retryTemperature(
              retryOpts.config.implementer.temperature,
              baseConfig.retryTemperatureStep,
              retryOpts.attempt,
            );
      return runPipeline(
        seat,
        retryOpts,
        prompt,
        retryOpts.attempt,
        temperature,
        prepared.baselines,
      );
    },

    ...DEFAULT_AVAILABILITY,
    capabilities: { writesFiles },
    ...(baseConfig.isAvailable && { isAvailable: baseConfig.isAvailable }),
    ...(baseConfig.unavailabilityReason && {
      unavailabilityReason: baseConfig.unavailabilityReason,
    }),
  };
}
