import type {
  Implementer,
  ImplementerOptions,
  ImplementerPublisher,
  ImplementerResult,
  InvokeOpts,
  RetryOptions,
} from '../types.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import type { RunnerCallContext, RunnerCallResult, RunnerCallStatus } from '../../calls/types.js';
import { toTokenDelta } from '../../calls/projection.js';
import type { Task } from '../../../core/schemas/task.js';
import { taskFiles } from '../../../core/schemas/task.js';
import { taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import {
  selectBuildOutputContract,
  type AppliedFile,
  type BuildOutputContract,
  type BundleApplyResult,
  type BundleBaseline,
} from '../file-bundle.js';
import { captureBundleBaseline } from '../bundle-baseline.js';
import { parseFileBundle } from '../parse-file-bundle.js';
import { applyFileBundle } from '../apply-file-bundle.js';
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
  runnerOwnWords,
  typedRunnerCallErrorMessage,
} from './call-result.js';
import { processImplementerOutput, readTaskFileContent } from './extracted-code.js';
import { usageLimitDetailFromError } from '../../runners/usage-limit.js';
import { isAuthFailureDiagnostic, runnerAuthDisplayName } from '../../runners/auth-failure.js';
import { isRecord } from '../../../utils/type-guards.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import {
  checkoutChanges,
  formatCheckoutChanges,
  snapshotCheckout,
  type CheckoutSnapshot,
} from '../isolation/checkout-audit.js';

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

/**
 * The brief as the confined filesystem holds it right now: the operation of
 * every declared target and the code the answer has to rewrite come from the
 * capture, never from a `currentCode` the brief carried in. An anchor the
 * capture reads as existing is a modify even when the brief still says create.
 */
function refreshTaskCode(task: Task, baselines: readonly BundleBaseline[]): Task {
  const anchor = baselines.find((baseline) => baseline.path === task.file);
  const byFile = Object.fromEntries(
    baselines.flatMap((baseline) =>
      baseline.path !== task.file && baseline.kind === 'text'
        ? ([[baseline.path, baseline.content]] as const)
        : [],
    ),
  );
  return {
    ...task,
    action: anchor?.operation ?? task.action,
    currentCode: anchor?.kind === 'text' ? anchor.content : undefined,
    currentCodeByFile: Object.keys(byFile).length > 0 ? byFile : undefined,
  };
}

/**
 * One brief, one diff: the applied files in the order they landed, each named
 * when more than one changed so the card can tell them apart, and the line
 * counts summed over the whole bundle.
 */
function aggregateApplied(applied: readonly AppliedFile[]): {
  diff: string;
  linesAdded: number;
  linesRemoved: number;
} {
  const diff =
    applied.length === 1
      ? (applied[0]?.diff ?? '')
      : applied.map((file) => `${file.path}\n${file.diff}`).join('\n');
  return {
    diff,
    linesAdded: applied.reduce((total, file) => total + file.linesAdded, 0),
    linesRemoved: applied.reduce((total, file) => total + file.linesRemoved, 0),
  };
}

export function createImplementerBase(baseConfig: ImplementerBaseConfig): Implementer {
  const shouldThrow = baseConfig.shouldThrow ?? defaultShouldThrow;
  const prependSystemPreamble = baseConfig.prependSystemPreamble !== false;
  const writesFiles = baseConfig.extractsCode ? 'extracted-code' : 'direct';
  const outputContract = baseConfig.outputContract ?? selectBuildOutputContract(baseConfig);
  /**
   * What this seat's own attempts actually created for a task. A retry after a
   * partial application rewrites the file it made instead of refusing to create
   * it twice. In-process only: a crash leaves no record here, and the capture
   * then parks the brief for recovery rather than assuming ownership.
   */
  const createdByTask = new Map<string, Set<string>>();
  const creationScope = (opts: ImplementerOptions): string =>
    JSON.stringify([opts.projectDir, opts.task.id]);
  const buildPrompt =
    baseConfig.buildPrompt ??
    ((opts: ImplementerOptions) =>
      formatTaskPrompt({
        task: opts.task,
        context: opts.context,
        contextLength: opts.config.implementer.contextLength,
        languageContext: opts.languageContext,
        writesFiles,
        outputContract,
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
        outputContract,
      }));

  function failTask(opts: ImplementerOptions): void {
    if (!opts.phase) return;
    baseConfig.publisher?.publishFailed({
      phase: opts.phase,
      taskId: opts.task.id,
      ...(opts.config.implementer.model !== undefined && { model: opts.config.implementer.model }),
    });
  }

  function bundleFailure(
    opts: ImplementerOptions,
    output: string,
    usage: TokenDelta | null,
    applyResult: Exclude<BundleApplyResult, { status: 'applied' }>,
  ): ImplementerResult {
    failTask(opts);
    return {
      success: false,
      output,
      error: applyResult.error,
      applyResult,
      ...(usage !== null && { usage }),
    };
  }

  /**
   * Every declared target's baseline, taken from the confined filesystem before
   * the prompt, the reserve or any generation exists. A capture that refuses is
   * a refusal of the whole brief: nothing is dispatched and nothing is written.
   */
  async function prepareCall(
    opts: ImplementerOptions,
  ): Promise<
    | { kind: 'ready'; opts: ImplementerOptions; baselines: readonly BundleBaseline[] }
    | { kind: 'refused'; result: ImplementerResult }
  > {
    if (outputContract !== 'file-bundle-v1') return { kind: 'ready', opts, baselines: [] };

    const captured = await captureBundleBaseline({
      projectDir: opts.projectDir,
      task: opts.task,
      createdByThisTask: [
        ...(createdByTask.get(creationScope(opts)) ?? []),
        ...(opts.createdByThisTask ?? []),
      ],
    });
    if (captured.kind === 'rejected') {
      const error = `${captured.path}: ${captured.error}`;
      return {
        kind: 'refused',
        result: bundleFailure(opts, '', null, {
          // The refusal precedes the call, so there is no call to name and no
          // response to have proposed a candidate.
          callId: null,
          candidatePaths: [],
          status: 'rejected',
          code: captured.code,
          error,
          applied: [],
          // A refusal before generation has no response to tell a no-op from an
          // omission: every declared target is simply untouched.
          noops: [],
          untouched: [...taskFiles(opts.task)].sort(),
        }),
      };
    }
    return {
      kind: 'ready',
      opts: { ...opts, task: refreshTaskCode(opts.task, captured.baselines) },
      baselines: captured.baselines,
    };
  }

  /**
   * The completed response as `file-bundle-v1`: validated whole against the
   * captured targets, then applied. What landed is the result — a rejection
   * wrote nothing, and a partial application is a failure that names what it
   * already changed.
   */
  async function applyBundleOutput(input: {
    opts: ImplementerOptions;
    baselines: readonly BundleBaseline[];
    callId: string;
    text: string;
    status: RunnerCallStatus;
    startTime: number;
    usage: TokenDelta | null;
  }): Promise<ImplementerResult> {
    const { opts, baselines, callId, text, usage } = input;

    const parsed = parseFileBundle({
      text,
      status: input.status,
      targets: baselines,
      scope: taskDeclaredPatterns(opts.task),
    });
    if (parsed.kind === 'rejected') {
      return bundleFailure(opts, text, usage, {
        callId,
        // A response the parser refused produced no candidate to apply.
        candidatePaths: [],
        status: 'rejected',
        code: parsed.code,
        error: parsed.error,
        applied: [],
        noops: [],
        untouched: baselines.map((baseline) => baseline.path),
      });
    }

    const applyResult = await applyFileBundle({
      projectDir: opts.projectDir,
      baselines,
      callId,
      candidates: parsed.candidates,
      noops: parsed.noops,
      approveWrite: opts.approveWrite,
      signal: opts.signal,
    });
    const created = applyResult.applied.filter((file) => file.action === 'create');
    if (created.length > 0) {
      const owned = createdByTask.get(creationScope(opts)) ?? new Set<string>();
      for (const file of created) owned.add(file.path);
      createdByTask.set(creationScope(opts), owned);
    }
    if (applyResult.status !== 'applied') return bundleFailure(opts, text, usage, applyResult);

    if (opts.phase) {
      const aggregate = aggregateApplied(applyResult.applied);
      baseConfig.publisher?.publishDone({
        phase: opts.phase,
        taskId: opts.task.id,
        file: opts.task.file,
        diff: aggregate.diff,
        linesAdded: aggregate.linesAdded,
        linesRemoved: aggregate.linesRemoved,
        duration: Date.now() - input.startTime,
      });
    }
    return {
      success: true,
      output: text,
      applyResult,
      ...(usage !== null && { usage }),
    };
  }

  /**
   * The checkout as the isolation audit reads it, or nothing when the read
   * failed: an audit that cannot see the checkout says so and lets the call
   * stand, rather than inventing an escape.
   */
  async function readCheckout(
    opts: ImplementerOptions,
    checkoutDir: string,
  ): Promise<CheckoutSnapshot | undefined> {
    try {
      return await snapshotCheckout(checkoutDir);
    } catch (err) {
      if (opts.phase) {
        baseConfig.publisher?.publishWarning({
          phase: opts.phase,
          taskId: opts.task.id,
          message: `The isolation audit could not read your checkout for task ${opts.task.id}: ${toErrorMessage(err)}`,
          safety: { category: 'implementer', code: 'isolation_audit_failed' },
        });
      }
      return undefined;
    }
  }

  /**
   * The git state that changed in the checkout across one implementer call — a
   * change that went around the isolation directory instead of through
   * promotion. The window is the call alone, so edits between calls never
   * count. A changed file is only reported: an editor save changes files too,
   * and the audit cannot tell who made it. A stopped call only reports its state
   * change: the run is already halting.
   */
  async function checkoutEscape(
    opts: ImplementerOptions,
    checkoutDir: string | undefined,
    before: CheckoutSnapshot | undefined,
  ): Promise<string[]> {
    if (checkoutDir === undefined || before === undefined) return [];
    const after = await readCheckout(opts, checkoutDir);
    if (after === undefined) return [];
    const { files, state } = checkoutChanges({ before, after });
    if (files.length > 0 && opts.phase) {
      baseConfig.publisher?.publishWarning({
        phase: opts.phase,
        taskId: opts.task.id,
        message: `Task ${opts.task.id}: your checkout changed while ${runnerAuthDisplayName(opts.config.implementer)} ran — ${formatCheckoutChanges(files)}; nothing there was reverted`,
        safety: { category: 'implementer', code: 'checkout_changed_during_call' },
      });
    }
    if (state.length === 0 || !opts.signal?.aborted) return state;
    if (opts.phase) {
      baseConfig.publisher?.publishWarning({
        phase: opts.phase,
        taskId: opts.task.id,
        message: `Task ${opts.task.id} was stopped; its implementer ran while your checkout changed: ${formatCheckoutChanges(state)}`,
        safety: { category: 'implementer', code: 'implementer_left_isolation' },
      });
    }
    return [];
  }

  async function runPipeline(
    opts: ImplementerOptions,
    rawPrompt: string,
    attempt: number,
    temperature: number | undefined,
    baselines: readonly BundleBaseline[],
  ): Promise<ImplementerResult> {
    const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
    const systemPreamble = formatImplementerSystemPreamble(
      languageContext,
      writesFiles,
      opts.projectDir,
      outputContract,
    );
    const prompt =
      prependSystemPreamble && systemPreamble ? systemPreamble + '\n\n' + rawPrompt : rawPrompt;
    const { task, projectDir, config, onOutput, sessionId, phase } = opts;

    assertPathConfined(task.file, projectDir);

    let oldContent: string | null = null;
    if (outputContract === 'legacy-code-v1') {
      oldContent = await readTaskFileContent(projectDir, task.file);
    }

    let changeBaseline: ChangeDetectorBaseline | undefined;
    if (!baseConfig.extractsCode && baseConfig.detectChanges) {
      changeBaseline = await captureChangeDetectorBaseline(projectDir, {
        kind: opts.changeDetection,
        ignoreProjectDir: opts.fileIgnoreProjectDir,
      });
    }

    // Every writer's output is logged, so a stopped call leaves the partial a continue reads
    // back. The log is the checkout's, also when a direct writer works in a copy of it.
    const implBuffer = sessionId
      ? createTranscriptBuffer({
          projectDir: opts.fileIgnoreProjectDir ?? projectDir,
          sessionId,
          phase: 'implementing',
        })
      : null;
    const wrappedOnOutput = (text: string, opts?: { messageStart?: boolean | undefined }) => {
      onOutput(text, opts);
      implBuffer?.append(text);
    };

    // A direct writer handed its own copy of the project may not touch the one it came from.
    const checkoutDir =
      !baseConfig.extractsCode &&
      opts.fileIgnoreProjectDir !== undefined &&
      opts.fileIgnoreProjectDir !== projectDir
        ? opts.fileIgnoreProjectDir
        : undefined;
    const checkoutBefore =
      checkoutDir === undefined ? undefined : await readCheckout(opts, checkoutDir);

    if (phase) baseConfig.publisher?.publishRunning({ phase, taskId: task.id, file: task.file });
    const startTime = Date.now();
    const callContext = createImplementerCallContext({
      config,
      backendKind: baseConfig.backendKind,
      attempt,
      taskId: task.id,
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
        undeclaredWrites: opts.undeclaredWrites,
        ...(opts.allowNoChange === true && { allowNoChange: true }),
        ...(checkoutDir !== undefined && { checkoutDir }),
        ...(opts.context.skillRoots !== undefined && { skillRoots: opts.context.skillRoots }),
      });
      callResult = invokeResult;
    } catch (err) {
      const escaped = await checkoutEscape(opts, checkoutDir, checkoutBefore);
      if (opts.signal?.aborted) {
        implBuffer?.flushInterrupted();
        return { success: false, output: '', error: ABORTED_OUTCOME_TEXT };
      }
      if (escaped.length > 0) {
        failTask(opts);
        return {
          success: false,
          output: errorOutput(err),
          error: formatCheckoutChanges(escaped),
          outcome: 'checkout-changed',
        };
      }
      if (shouldThrow(err)) throw err;
      const output = errorOutput(err);
      failTask(opts);
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
        return {
          success: false,
          output,
          error: runnerOwnWords(err) ?? classification,
          outcome: 'unauthenticated',
        };
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

    const escaped = await checkoutEscape(opts, checkoutDir, checkoutBefore);
    if (escaped.length > 0) {
      implBuffer?.flush();
      failTask(opts);
      // A call the tripwire already stopped keeps its own evidence ahead of what the audit found.
      if (
        callResult.status !== 'completed' &&
        callResult.error.code === 'implementer-left-isolation'
      ) {
        return {
          success: false,
          output: outputText,
          error: `${callResult.error.message}; ran while your checkout changed: ${formatCheckoutChanges(escaped)}`,
          outcome: 'implementer-left-isolation',
          ...usageField,
        };
      }
      return {
        success: false,
        output: outputText,
        error: formatCheckoutChanges(escaped),
        outcome: 'checkout-changed',
        ...usageField,
      };
    }

    if (callResult.status !== 'completed') {
      if (callResult.status === 'aborted' && opts.signal?.aborted) {
        implBuffer?.flushInterrupted();
      } else {
        implBuffer?.flush();
        failTask(opts);
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

    let noChange = false;
    try {
      if (outputContract === 'file-bundle-v1') {
        return await applyBundleOutput({
          opts,
          baselines,
          callId: callContext.callId,
          text: outputText,
          status: callResult.status,
          startTime,
          usage,
        });
      }

      if (outputContract === 'legacy-code-v1') {
        const result = await processImplementerOutput({
          text: outputText,
          task,
          projectDir,
          approvedBaselineContent: oldContent,
          approveWrite: opts.approveWrite,
        });
        if (!result.success) {
          failTask(opts);
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
        noChange = !changes.changed;
        if (noChange && opts.allowNoChange !== true) {
          if (phase) {
            baseConfig.publisher?.publishWarning({
              phase,
              taskId: task.id,
              message: `Implementer ${getRunnerDisplayName(config.implementer)} wrote nothing for task ${task.id}: ${changes.output}`,
              safety: {
                category: 'implementer',
                code: 'implementer_wrote_nothing',
              },
            });
          }
          failTask(opts);
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
      failTask(opts);
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
        ...(noChange && { noChange: true }),
      });
    }
    return { success: true, output: outputText, ...usageField };
  }

  return {
    async implement(opts: ImplementerOptions): Promise<ImplementerResult> {
      const prepared = await prepareCall(opts);
      if (prepared.kind === 'refused') return prepared.result;
      // A restarted brief is the same brief: the prompt is the brief's own, with
      // the cut attempt's partial and the files it already wrote trailing it.
      const base = buildPrompt(prepared.opts);
      const prompt =
        prepared.opts.continuation === undefined
          ? base
          : composeContinuation({ basePrompt: base, ...prepared.opts.continuation });
      return runPipeline(prepared.opts, prompt, 0, undefined, prepared.baselines);
    },

    async retry(opts: RetryOptions): Promise<ImplementerResult> {
      const prepared = await prepareCall(opts);
      if (prepared.kind === 'refused') return prepared.result;
      const retryOpts: RetryOptions = { ...opts, task: prepared.opts.task };
      const base = buildRetryPrompt(retryOpts);
      const prompt =
        retryOpts.continuation === undefined
          ? base
          : composeContinuation({ basePrompt: base, ...retryOpts.continuation });
      const temperature =
        retryOpts.kind === 'hint'
          ? retryOpts.config.implementer.temperature
          : retryTemperature(
              retryOpts.config.implementer.temperature,
              baseConfig.retryTemperatureStep,
              retryOpts.attempt,
            );
      return runPipeline(retryOpts, prompt, retryOpts.attempt, temperature, prepared.baselines);
    },

    ...DEFAULT_AVAILABILITY,
    capabilities: { writesFiles },
    ...(baseConfig.isAvailable && { isAvailable: baseConfig.isAvailable }),
    ...(baseConfig.unavailabilityReason && {
      unavailabilityReason: baseConfig.unavailabilityReason,
    }),
  };
}
