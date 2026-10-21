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
  summarizeChanges,
  orderChangedFiles,
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
import { classifySeatFailure } from '../../runners/seat-failure.js';
import { runnerAuthDisplayName } from '../../runners/auth-failure.js';
import { extractLastJsonObject } from '../../runners/typed-output.js';
import { ImplementerReportSchema, type ImplementerReport } from '../../../core/schemas/consult.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { isRecord } from '../../../utils/type-guards.js';
import { processError } from '../../../lib/process/errors.js';
import { isApiDeadlineError } from '../../providers/api-deadlines.js';
import {
  checkoutChanges,
  formatCheckoutChanges,
  snapshotCheckout,
  snapshotWorkspaceGit,
  workspaceGitChanges,
  type CheckoutSnapshot,
  type WorkspaceGitSnapshot,
} from '../isolation/checkout-audit.js';

const MAX_RETRY_TEMPERATURE = 2;

/** The checkout and the call's own workspace git state, read as one pair. */
type CheckoutRead = Readonly<{
  checkout: CheckoutSnapshot;
  workspace: WorkspaceGitSnapshot | null;
}>;

const lastInPlaceByRun = new Map<string, { before: CheckoutRead; after: CheckoutRead }>();

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

/** The call edits the checkout itself: `workflow.isolation: none` hands every writer the project. */
function worksInPlace(opts: ImplementerOptions): boolean {
  return opts.fileIgnoreProjectDir !== undefined && opts.fileIgnoreProjectDir === opts.projectDir;
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
  const anchor = baselines.find((baseline) => baseline.path === task.suggestedFiles[0]);
  const byFile = Object.fromEntries(
    baselines.flatMap((baseline) =>
      baseline.path !== task.suggestedFiles[0] && baseline.kind === 'text'
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

/**
 * The direct writer's closing report: the last JSON object of the reply, taken
 * as it is. A report that is missing or does not match the contract changes
 * nothing, and there is no repair call.
 */
function parseImplementerReport(text: string): ImplementerReport | undefined {
  const extracted = extractLastJsonObject(text);
  if (extracted.kind !== 'ok') return undefined;
  const parsed = ImplementerReportSchema.safeParse(extracted.value);
  return parsed.success ? parsed.data : undefined;
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
        plan: opts.plan,
        inPlace: worksInPlace(opts),
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
        plan: opts.plan,
        inPlace: worksInPlace(opts),
      }));

  function failTask(opts: ImplementerOptions, error: string): void {
    if (!opts.phase) return;
    baseConfig.publisher?.publishFailed({
      phase: opts.phase,
      taskId: opts.task.id,
      error,
      ...(opts.config.implementer.model !== undefined && { model: opts.config.implementer.model }),
    });
  }

  function bundleFailure(
    opts: ImplementerOptions,
    output: string,
    usage: TokenDelta | null,
    applyResult: Exclude<BundleApplyResult, { status: 'applied' }>,
  ): ImplementerResult {
    failTask(opts, applyResult.error);
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
      createdByThisTask:
        worksInPlace(opts) && opts.createdByThisTask !== undefined
          ? opts.createdByThisTask
          : [...(createdByTask.get(creationScope(opts)) ?? []), ...(opts.createdByThisTask ?? [])],
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
          untouched: [...opts.task.suggestedFiles].sort(),
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
    if (parsed.kind === 'blocked') {
      return {
        success: false,
        output: text,
        error: `Implementer is blocked: ${parsed.question}`,
        blocked: { question: parsed.question, filesNeeded: parsed.filesNeeded },
        ...(usage !== null && { usage }),
      };
    }
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
        file: opts.task.suggestedFiles[0],
        files: orderChangedFiles(
          applyResult.applied.map((file) => file.path),
          opts.task.suggestedFiles,
        ),
        diff: aggregate.diff,
        linesAdded: aggregate.linesAdded,
        linesRemoved: aggregate.linesRemoved,
        duration: Date.now() - input.startTime,
        kept: opts.continuation?.kept,
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
   * The checkout and the call's own workspace as the isolation audit reads
   * them, or nothing when either read failed: an audit that cannot see the
   * checkout says so and lets the call stand, rather than inventing an escape.
   */
  async function readCheckout(
    opts: ImplementerOptions,
    checkoutDir: string,
    workspaceDir: string,
  ): Promise<CheckoutRead | undefined> {
    try {
      const [checkout, workspace] = await Promise.all([
        snapshotCheckout(checkoutDir),
        snapshotWorkspaceGit(workspaceDir, checkoutDir),
      ]);
      return { checkout, workspace };
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
   * The git state that changed in the checkout or the call's own workspace
   * across one implementer call — a change that went around the isolation
   * directory instead of through promotion. The window is the call alone, so
   * edits between calls never count. A changed file is only reported: an editor
   * save changes files too, and the audit cannot tell who made it. In the
   * checkout itself the call's own writes are the files that change, so none
   * is reported. A stopped call only reports its state change: the run is
   * already halting.
   */
  async function checkoutEscape(
    opts: ImplementerOptions,
    checkoutDir: string | undefined,
    before: CheckoutRead | undefined,
  ): Promise<string[]> {
    if (checkoutDir === undefined || before === undefined) return [];
    const after = await readCheckout(opts, checkoutDir, opts.projectDir);
    if (after === undefined) return [];
    const { files, state: checkoutState } = checkoutChanges({
      before: before.checkout,
      after: after.checkout,
    });
    const state = [
      ...checkoutState,
      ...workspaceGitChanges({ before: before.workspace, after: after.workspace }),
    ];
    if (files.length > 0 && !worksInPlace(opts) && opts.phase) {
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

  /**
   * An in-place call warns about what changed in the checkout since the last
   * one ended — an edit or a commit of yours. It never halts: the next checks
   * read the checkout as it is.
   */
  function warnChangedBetweenCalls(
    opts: ImplementerOptions,
    now: CheckoutRead,
    runKey: string,
  ): void {
    const last = lastInPlaceByRun.get(runKey);
    if (last === undefined || !opts.phase) return;
    const { files, state } = checkoutChanges({ before: last.after.checkout, after: now.checkout });
    const changes = [
      ...files.filter((file) => now.checkout.files[file] !== last.before.checkout.files[file]),
      ...state,
      ...workspaceGitChanges({ before: last.after.workspace, after: now.workspace }),
    ];
    if (changes.length === 0) return;
    baseConfig.publisher?.publishWarning({
      phase: opts.phase,
      taskId: opts.task.id,
      message: `Task ${opts.task.id}: your checkout changed since the last call — ${formatCheckoutChanges(changes)}; the next checks read it as it is`,
      safety: { category: 'implementer', code: 'checkout_changed_between_calls' },
    });
  }

  async function runPipeline(
    opts: ImplementerOptions,
    rawPrompt: string,
    attempt: number,
    temperature: number | undefined,
    baselines: readonly BundleBaseline[],
  ): Promise<ImplementerResult> {
    // A writer handed its own workspace may not touch the checkout it came from; one that works
    // in the checkout itself is audited there.
    const checkoutDir = opts.fileIgnoreProjectDir;
    const checkoutBefore =
      checkoutDir === undefined
        ? undefined
        : await readCheckout(opts, checkoutDir, opts.projectDir);
    if (!worksInPlace(opts)) {
      return runCall(opts, rawPrompt, attempt, temperature, baselines, checkoutBefore);
    }
    const runKey =
      opts.sessionId === undefined ? undefined : JSON.stringify([opts.projectDir, opts.sessionId]);
    if (checkoutBefore !== undefined && runKey !== undefined)
      warnChangedBetweenCalls(opts, checkoutBefore, runKey);
    const result = await runCall(opts, rawPrompt, attempt, temperature, baselines, checkoutBefore);
    const after = await readCheckout(opts, opts.projectDir, opts.projectDir);
    if (runKey === undefined) return result;
    // Without both reads this call's own writes cannot be told from yours, so the next call starts fresh.
    if (checkoutBefore === undefined || after === undefined) lastInPlaceByRun.delete(runKey);
    else lastInPlaceByRun.set(runKey, { before: checkoutBefore, after });
    return result;
  }

  async function runCall(
    opts: ImplementerOptions,
    rawPrompt: string,
    attempt: number,
    temperature: number | undefined,
    baselines: readonly BundleBaseline[],
    checkoutBefore: CheckoutRead | undefined,
  ): Promise<ImplementerResult> {
    const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
    const systemPreamble = formatImplementerSystemPreamble(
      languageContext,
      writesFiles,
      opts.projectDir,
      outputContract,
      worksInPlace(opts),
    );
    const prompt =
      prependSystemPreamble && systemPreamble ? systemPreamble + '\n\n' + rawPrompt : rawPrompt;
    const { task, projectDir, config, onOutput, sessionId, phase } = opts;

    assertPathConfined(task.suggestedFiles[0], projectDir);

    let oldContent: string | null = null;
    if (outputContract === 'legacy-code-v1') {
      oldContent = await readTaskFileContent(projectDir, task.suggestedFiles[0]);
    }

    let changeBaseline: ChangeDetectorBaseline | undefined;
    if (outputContract === 'direct') {
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

    const checkoutDir = opts.fileIgnoreProjectDir;

    if (phase)
      baseConfig.publisher?.publishRunning({
        phase,
        taskId: task.id,
        file: task.suggestedFiles[0],
        lineageAttempts: opts.lineageAttempts,
      });
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
        phase,
        ...(temperature !== undefined && { temperature }),
        signal: opts.signal,
        steering: opts.steering,
        images: opts.images,
        onCallEvent: (event) => {
          if (phase)
            baseConfig.publisher?.publishCallEvent({
              phase,
              taskId: task.id,
              rootDir: projectDir,
              event,
            });
        },
        sandboxEnv: opts.sandboxEnv,
        ...(opts.changeDetection !== undefined && { changeDetection: opts.changeDetection }),
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
        return { success: false, output: '', error: ABORTED_OUTCOME_TEXT, outcome: 'user-abort' };
      }
      if (escaped.length > 0) {
        const error = formatCheckoutChanges(escaped);
        failTask(opts, error);
        return {
          success: false,
          output: errorOutput(err),
          error,
          outcome: 'checkout-changed',
        };
      }
      if (shouldThrow(err)) throw err;
      const output = errorOutput(err);
      // API backends throw their provider errors instead of returning a
      // failed call result, so the one classifier reads them here too. The raw
      // provider detail is kept over the rewritten hint: the recovery needs
      // the reset time the provider's own words carry.
      const data = isRecord(err) && isRecord(err.data) ? err.data : undefined;
      const rawStatus = data?.status ?? data?.statusCode;
      const status = typeof rawStatus === 'number' ? rawStatus : undefined;
      const words = runnerOwnWords(err) ?? toErrorMessage(err);
      const classification = classifySeatFailure({
        message: words,
        ...(status !== undefined && { status }),
        source: 'thrown',
      });
      if (classification.class === 'account' || classification.class === 'rate-limited') {
        const authFailure = classification.class === 'account' && classification.cause === 'auth';
        failTask(opts, words);
        return {
          success: false,
          output,
          error: words,
          outcome: authFailure ? 'unauthenticated' : 'usage-limit',
        };
      }
      const error = formatErrorWithHint(typedRunnerCallErrorMessage(err) ?? toErrorMessage(err));
      failTask(opts, error);
      return {
        success: false,
        output,
        error,
        ...((processError.isTimeout(err) || isApiDeadlineError(err)) && { outcome: 'timeout' }),
        ...(processError.isIdleTimeout(err) && { outcome: 'no-progress-cut' }),
      };
    }

    const usage = toTokenDelta(callResult.usage);
    const usageField = usage !== null ? { usage } : {};
    const outputText = callResult.text;

    const escaped = await checkoutEscape(opts, checkoutDir, checkoutBefore);
    if (escaped.length > 0) {
      implBuffer?.flush();
      const changes = formatCheckoutChanges(escaped);
      // A call the tripwire already stopped keeps its own evidence ahead of what the audit found.
      if (
        callResult.status !== 'completed' &&
        callResult.error.code === 'implementer-left-isolation'
      ) {
        const error = `${callResult.error.message}; ran while your checkout changed: ${changes}`;
        failTask(opts, error);
        return {
          success: false,
          output: outputText,
          error,
          outcome: 'implementer-left-isolation',
          ...usageField,
        };
      }
      failTask(opts, changes);
      return {
        success: false,
        output: outputText,
        error: changes,
        outcome: 'checkout-changed',
        ...usageField,
      };
    }

    if (callResult.status !== 'completed') {
      const error = runnerCallFailureMessage(callResult, opts.signal);
      if (callResult.status === 'aborted' && opts.signal?.aborted) {
        implBuffer?.flushInterrupted();
      } else {
        implBuffer?.flush();
        failTask(opts, error);
      }
      const outcome = runnerCallOutcome(callResult);
      return {
        success: false,
        output: outputText,
        error,
        ...(outcome.state !== 'success' && { outcome: outcome.state }),
        ...usageField,
      };
    }

    implBuffer?.flush();

    const report = outputContract === 'direct' ? parseImplementerReport(outputText) : undefined;
    if (report?.status === 'blocked') {
      return {
        success: false,
        output: outputText,
        error: `Implementer is blocked: ${report.question}`,
        report,
        blocked: { question: report.question, filesNeeded: report.filesNeeded },
        ...usageField,
      };
    }

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
          failTask(opts, result.error);
          return { success: false, output: outputText, error: result.error, ...usageField };
        }
        if (phase) {
          baseConfig.publisher?.publishDone({
            phase,
            taskId: task.id,
            file: task.suggestedFiles[0],
            files: [task.suggestedFiles[0]],
            diff: result.diff,
            linesAdded: result.linesAdded,
            linesRemoved: result.linesRemoved,
            duration: Date.now() - startTime,
            kept: opts.continuation?.kept,
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
          failTask(opts, changes.output);
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
      const error = toErrorMessage(err);
      failTask(opts, error);
      return {
        success: false,
        output: outputText,
        error,
        ...usageField,
      };
    }

    if (phase && changeBaseline !== undefined) {
      const changes = await summarizeChanges(projectDir, changeBaseline, task.suggestedFiles);
      baseConfig.publisher?.publishDone({
        phase,
        taskId: task.id,
        file: task.suggestedFiles[0],
        ...changes,
        duration: Date.now() - startTime,
        ...(noChange && { noChange: true }),
        kept: opts.continuation?.kept,
      });
    }
    return {
      success: true,
      output: outputText,
      ...(report !== undefined && { report }),
      ...usageField,
    };
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
          : composeContinuation({ basePrompt: base, ...retryOpts.continuation, discarded: true });
      const temperature =
        retryOpts.kind === 'consult'
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
