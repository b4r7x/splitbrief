import type { OutputFormat } from '../../../core/schemas/enums.js';
import { RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner/fields.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import { redactSecrets } from '../../../utils/redact/secrets.js';
import { createRunnerCallRecorder } from '../../calls/recorder/create.js';
import { createRunnerCallCredentialRedactor } from '../../calls/status.js';
import type { RunnerCallEvent, RunnerCallContext } from '../../calls/types.js';
import type { TextChunkMarks } from '../../events/types.js';
import type { CustomRunnerRedactor } from '../../runners/custom/redaction.js';
import { credentialValuesFromEnvironment } from '../../runners/sandbox/credential-values.js';
import { getLineParser } from '../parse/select.js';
import { createParsedLineRecorder } from '../parsed-line-recorder.js';
import { createInvocationCancellation } from './cancellation.js';
import {
  applyParsed,
  createRedactedStream,
  flushStderr,
  flushStdout,
  pushStderr,
  toolInputCapacitySignal,
} from './redacted-stream.js';
import { thrownCollectResult } from './thrown.js';
import type { CollectCall, CollectResult } from './types.js';

interface SpawnAndCollectOptions {
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  format?: OutputFormat | undefined;
  notFoundMessage?: string | undefined;
  onText?: ((text: string, marks?: TextChunkMarks) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext: RunnerCallContext;
  signal?: AbortSignal | undefined;
  // Defaults are applied here in spawnAndCollect, the single defaulting site —
  // callers pass configured overrides through.
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
  /** The seat's opt-in `maxToolCalls`; unset, no tool-call count ends the call. */
  maxToolCalls?: number | undefined;
  /** Credential values are passed explicitly so callbacks never receive raw secrets. */
  credentialValues?: readonly string[] | undefined;
  /**
   * Optional hard wall-clock deadline. The collector owns composition with an
   * external cancellation signal so the detached lifecycle reaps the process
   * tree for either outcome.
   */
  timeoutMs?: number | undefined;
  /** Redacts invocation-specific values before they reach controlled surfaces. */
  redact?: CustomRunnerRedactor | undefined;
}

export async function spawnAndCollect(opts: SpawnAndCollectOptions): Promise<CollectResult> {
  const parseLine = getLineParser(opts.format ?? 'text');
  const call = createCollectCall(opts);
  const { stream, recorder, parsedRecorder, cancellation } = call;

  try {
    await spawnWithStdin({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      notFoundMessage: opts.notFoundMessage,
      onStderr: (chunk) => {
        pushStderr(stream, chunk);
        return toolInputCapacitySignal(stream);
      },
      signal: cancellation.signal,
      idle: {
        warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
        killMs: opts.idle?.killMs,
        onWarn: (silentMs) => recorder.stalled({ silentMs }),
        onClear: () => recorder.stallCleared(),
      },
      onLine(line) {
        applyParsed(stream, parseLine(line));
        return toolInputCapacitySignal(stream);
      },
    });
  } catch (err) {
    return thrownCollectResult(call, err);
  } finally {
    cancellation.cleanup();
  }

  flushStdout(stream);
  flushStderr(stream);
  if (!recorder.hasTerminal()) {
    recorder.finishCompleted({ nativeSessionId: parsedRecorder.sessionId });
  }

  const result = recorder.finalResult();
  return { ...result, sessionId: parsedRecorder.sessionId };
}

function createCollectCall(opts: SpawnAndCollectOptions): CollectCall {
  const credentialValues =
    opts.credentialValues ?? credentialValuesFromEnvironment(opts.env ?? process.env);
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => {
    const redactedCredentials = redactSecrets(explicitRedactor(value));
    return opts.redact?.(redactedCredentials) ?? redactedCredentials;
  };
  const limitController = new AbortController();
  const cancellation = createInvocationCancellation(
    opts.signal === undefined
      ? limitController.signal
      : AbortSignal.any([opts.signal, limitController.signal]),
    opts.timeoutMs,
  );
  const recorder = createRunnerCallRecorder({
    context: opts.callContext,
    credentialValues,
    stopAfterToolUses: opts.maxToolCalls,
    onLimit: () => limitController.abort(),
    onEvent: opts.onCallEvent,
  });
  const parsedRecorder = createParsedLineRecorder({ recorder, onText: opts.onText });
  const stream = createRedactedStream({
    redact: opts.redact,
    redactCredential,
    credentialValues,
    recorder,
    parsedRecorder,
    onStderr: opts.onStderr,
  });
  return {
    command: opts.command,
    timeoutMs: opts.timeoutMs,
    credentialValues,
    redactCredential,
    limitSignal: limitController.signal,
    cancellation,
    recorder,
    parsedRecorder,
    stream,
  };
}
