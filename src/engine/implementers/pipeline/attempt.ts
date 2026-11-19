import type { ImplementerOptions, ImplementerResult, InvokeOpts } from '../types.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import type { TextChunkMarks } from '../../events/types.js';
import type { BundleBaseline } from '../file-bundle/contract.js';
import type { ImplementerWriteMode } from '../../../core/schemas/runner/implementer.js';
import { assertPathConfined } from '../../../lib/fs/confinement.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { formatErrorWithHint } from '../../error-hints.js';
import { buildImplementerSystemPreamble } from '../../spec/prompts/system.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import {
  captureChangeDetectorBaseline,
  type ChangeDetectorBaseline,
} from '../../change-detection.js';
import { classifyHaltSignature } from '../../../core/pipeline-spec/halts.js';
import {
  ABORTED_OUTCOME_TEXT,
  createImplementerCallContext,
  errorOutput,
  failureStateFromCode,
  isSeatDown,
  thrownSeatFailure,
  typedRunnerCallError,
  typedRunnerCallErrorMessage,
} from './call-result.js';
import { readTaskFileContent } from './extracted-code.js';
import { processError } from '../../../lib/process/errors.js';
import { isApiDeadlineError } from '../../providers/api/deadlines.js';
import { cliToolCheckError, cliToolCheckWords } from '../../runners/seat-gates.js';
import { formatCheckoutChanges } from '../isolation/checkout-audit.js';
import {
  checkoutEscape,
  readCheckout,
  recordInPlaceCall,
  warnChangedBetweenCalls,
  worksInPlace,
  type CheckoutRead,
} from './checkout-guard.js';
import { callOutcome } from './call-outcome.js';
import type { CallSeat } from './types.js';

/** What one attempt of a call takes from its implementer seat. */
type AttemptSeat = CallSeat &
  Readonly<{
    writesFiles: ImplementerWriteMode;
    prependSystemPreamble: boolean;
    shouldThrow: (err: unknown) => boolean;
    backendKind: RunnerCallContext['backendKind'] | undefined;
    invoke: (opts: InvokeOpts) => Promise<RunnerCallResult>;
  }>;

export async function runPipeline(
  seat: AttemptSeat,
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
      : await readCheckout(seat.publisher, opts, checkoutDir, opts.projectDir);
  if (!worksInPlace(opts)) {
    return runCall(seat, opts, rawPrompt, attempt, temperature, baselines, checkoutBefore);
  }
  const runKey =
    opts.sessionId === undefined ? undefined : JSON.stringify([opts.projectDir, opts.sessionId]);
  if (checkoutBefore !== undefined && runKey !== undefined)
    warnChangedBetweenCalls(seat.publisher, opts, checkoutBefore, runKey);
  const result = await runCall(
    seat,
    opts,
    rawPrompt,
    attempt,
    temperature,
    baselines,
    checkoutBefore,
  );
  const after = await readCheckout(seat.publisher, opts, opts.projectDir, opts.projectDir);
  if (runKey === undefined) return result;
  recordInPlaceCall(runKey, checkoutBefore, after);
  return result;
}

async function runCall(
  seat: AttemptSeat,
  opts: ImplementerOptions,
  rawPrompt: string,
  attempt: number,
  temperature: number | undefined,
  baselines: readonly BundleBaseline[],
  checkoutBefore: CheckoutRead | undefined,
): Promise<ImplementerResult> {
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const systemPreamble = buildImplementerSystemPreamble(
    languageContext,
    seat.writesFiles,
    opts.projectDir,
    seat.outputContract,
    worksInPlace(opts),
  );
  const prompt =
    seat.prependSystemPreamble && systemPreamble ? systemPreamble + '\n\n' + rawPrompt : rawPrompt;
  const { task, projectDir, config, onOutput, sessionId, phase } = opts;

  assertPathConfined(task.suggestedFiles[0], projectDir);

  let oldContent: string | null = null;
  if (seat.outputContract === 'legacy-code-v1') {
    oldContent = await readTaskFileContent(projectDir, task.suggestedFiles[0]);
  }

  let changeBaseline: ChangeDetectorBaseline | undefined;
  if (seat.outputContract === 'direct') {
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
  const wrappedOnOutput = (text: string, opts?: TextChunkMarks) => {
    onOutput(text, opts);
    implBuffer?.append(text);
  };

  const checkoutDir = opts.fileIgnoreProjectDir;

  if (phase)
    seat.publisher?.publishRunning({
      phase,
      taskId: task.id,
      file: task.suggestedFiles[0],
      lineageAttempt: opts.lineageAttempt,
    });
  const startTime = Date.now();
  const callContext = createImplementerCallContext({
    config,
    backendKind: seat.backendKind,
    attempt,
    taskId: task.id,
  });

  let callResult: RunnerCallResult;
  try {
    const invokeResult = await seat.invoke({
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
          seat.publisher?.publishCallEvent({
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
    return thrownOutcome(seat, { opts, err, implBuffer, checkoutDir, checkoutBefore });
  }

  return callOutcome(seat, {
    opts,
    callResult,
    callId: callContext.callId,
    startTime,
    implBuffer,
    checkoutDir,
    checkoutBefore,
    baselines,
    oldContent,
    changeBaseline,
  });
}

async function thrownOutcome(
  seat: AttemptSeat,
  input: Readonly<{
    opts: ImplementerOptions;
    err: unknown;
    implBuffer: ReturnType<typeof createTranscriptBuffer> | null;
    checkoutDir: string | undefined;
    checkoutBefore: CheckoutRead | undefined;
  }>,
): Promise<ImplementerResult> {
  const { opts, err, implBuffer, checkoutDir, checkoutBefore } = input;
  const escaped = await checkoutEscape(seat.publisher, opts, checkoutDir, checkoutBefore);
  if (opts.signal?.aborted) {
    implBuffer?.flushInterrupted();
    return { success: false, output: '', error: ABORTED_OUTCOME_TEXT, outcome: 'user-abort' };
  }
  if (escaped.length > 0) {
    const error = formatCheckoutChanges(escaped);
    seat.failTask(opts, error);
    return {
      success: false,
      output: errorOutput(err),
      error,
      outcome: 'checkout-changed',
    };
  }
  if (seat.shouldThrow(err)) throw err;
  const output = errorOutput(err);
  const transportError = typedRunnerCallError(err);
  if (transportError?.code === 'prompt-transport-error') {
    implBuffer?.flush();
    const error = toErrorMessage(err);
    seat.failTask(opts, error);
    return {
      success: false,
      output,
      error,
      outcome: failureStateFromCode(transportError.code) ?? undefined,
      transportError,
    };
  }
  // A tool that changed during the run and failed its new check: a sign-in
  // failure takes the sign-out route, which quotes the check's words and
  // gives its own login step; every other cause halts on the check and its fix.
  if (cliToolCheckError.isFailed(err)) {
    const signedOut = err.data.cause === 'unauthenticated';
    const error = signedOut ? err.message : cliToolCheckWords(err);
    seat.failTask(opts, error);
    return {
      success: false,
      output,
      error,
      outcome: signedOut ? 'unauthenticated' : 'runner-check-failed',
    };
  }
  // API backends throw their provider errors instead of returning a
  // failed call result, so the one classifier reads them here too. The raw
  // provider detail is kept over the rewritten hint: the recovery needs
  // the reset time the provider's own words carry.
  const { words, classification } = thrownSeatFailure(err);
  if (isSeatDown(classification)) {
    const authFailure = classification.class === 'account' && classification.cause === 'auth';
    seat.failTask(opts, words);
    return {
      success: false,
      output,
      error: words,
      outcome: authFailure ? 'unauthenticated' : 'usage-limit',
    };
  }
  // A provider or a tool that refuses the prompt as too long refuses the same prompt on every retry.
  if (classifyHaltSignature([words]) === 'input-too-large') {
    seat.failTask(opts, words);
    return { success: false, output, error: words, outcome: 'input-too-large' };
  }
  const error = formatErrorWithHint(typedRunnerCallErrorMessage(err) ?? toErrorMessage(err));
  seat.failTask(opts, error);
  return {
    success: false,
    output,
    error,
    ...((processError.isTimeout(err) || isApiDeadlineError(err)) && { outcome: 'timeout' }),
    ...(processError.isIdleTimeout(err) && { outcome: 'no-progress-cut' }),
  };
}
