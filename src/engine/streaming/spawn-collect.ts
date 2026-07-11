import type { OutputFormat } from '../../core/schemas/enums.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { ParsedLine } from '../runners/types.js';
import { processError } from '../../lib/process/errors.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import {
  finishRunnerCallOutputLimit,
  runnerCallLimitWarning,
  runnerCallLineOutputLimit,
} from '../calls/output-limit.js';
import { getLineParser } from './output-parsers.js';
import { parseTextLine } from './parse-text.js';
import { createParsedLineRecorder } from './parsed-line-recorder.js';
import { createRunnerCallStderrBuffer } from './stderr-lines.js';

interface SpawnAndCollectOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  format?: OutputFormat | undefined;
  parseLine?: ((line: string) => ParsedLine) | undefined;
  notFoundMessage?: string | undefined;
  onText?: ((text: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
  // Defaults are applied here in spawnAndCollect, the single defaulting site —
  // callers pass configured overrides through.
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
}

let callSequence = 0;

export async function spawnAndCollect(
  opts: SpawnAndCollectOptions,
): Promise<RunnerCallResult & { sessionId?: string | null }> {
  const parseLine = opts.parseLine ?? getLineParser(opts.format ?? 'text');
  const context =
    opts.callContext ??
    ({
      callId: `call-${++callSequence}`,
      role: 'implementer',
      backendKind: 'cli',
      runnerName: opts.command,
    } satisfies RunnerCallContext);

  const recorder = createRunnerCallRecorder({ context, onEvent: opts.onCallEvent });
  const parsedRecorder = createParsedLineRecorder({
    recorder,
    onText: opts.onText,
    onSessionId: opts.onSessionId,
  });
  const stderrBuffer = createRunnerCallStderrBuffer(recorder);

  try {
    await spawnWithStdin({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      notFoundMessage: opts.notFoundMessage,
      onStderr: (chunk) => {
        stderrBuffer.push(chunk);
        opts.onStderr?.(chunk);
      },
      signal: opts.signal,
      idle: {
        warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
        killMs: opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS,
        onWarn: (silentMs) => recorder.stalled({ silentMs }),
        onClear: () => recorder.stallCleared(),
      },
      onStdoutLineOverflow: (overflow) => {
        const limit = runnerCallLineOutputLimit({
          code: 'stdout_line_overflow',
          label: 'stdout line',
          lineBytes: overflow.lineBytes,
          maxLineBytes: overflow.maxLineBytes,
        });
        // Plain text loses only the overlong line, so warn and keep collecting
        // (mirrors stderr overflow); structured line protocols lose a whole
        // frame, which invalidates the result.
        if (parseLine === parseTextLine) {
          recorder.warning({ warning: runnerCallLimitWarning(limit) });
          return;
        }
        finishRunnerCallOutputLimit(recorder, limit, {
          usage: parsedRecorder.usage,
          nativeSessionId: parsedRecorder.sessionId,
        });
      },
      onLine(line) {
        parsedRecorder.apply(parseLine(line));
      },
    });
  } catch (err) {
    stderrBuffer.flush();
    if (!recorder.hasTerminal()) {
      if (processError.isIdleTimeout(err)) {
        recorder.finishFailed({
          status: 'failed',
          error: runnerCallIdleTimeoutError(err),
        });
      } else {
        recorder.finishFailed({
          status: opts.signal?.aborted ? runnerCallInterruptedStatus(opts.signal) : 'failed',
          error: runnerCallErrorFromUnknown(
            err,
            opts.signal?.aborted ? 'runner_interrupted' : 'runner_process_error',
          ),
        });
      }
    }
    throw err;
  }

  stderrBuffer.flush();
  if (!recorder.hasTerminal()) {
    recorder.finishCompleted({ nativeSessionId: parsedRecorder.sessionId });
  }

  const result = recorder.finalResult();
  return { ...result, sessionId: parsedRecorder.sessionId };
}
