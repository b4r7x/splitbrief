import type { OutputFormat } from '../../core/schemas/enums.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { ParsedLine } from '../runners/types.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import { getLineParser } from './output-parsers.js';
import { createParsedLineRecorder } from './parsed-line-recorder.js';

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

  try {
    await spawnWithStdin({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      notFoundMessage: opts.notFoundMessage,
      onStderr: (chunk) => {
        recorder.stderr({ text: chunk });
        opts.onStderr?.(chunk);
      },
      signal: opts.signal,
      onLine(line) {
        parsedRecorder.apply(parseLine(line));
      },
    });
  } catch (err) {
    if (!recorder.hasTerminal()) {
      recorder.finishFailed({
        status: opts.signal?.aborted ? runnerCallInterruptedStatus(opts.signal) : 'failed',
        error: runnerCallErrorFromUnknown(
          err,
          opts.signal?.aborted ? 'runner_interrupted' : 'runner_process_error',
        ),
      });
    }
    throw err;
  }

  if (!recorder.hasTerminal()) {
    recorder.finishCompleted({ nativeSessionId: parsedRecorder.sessionId });
  }

  const result = recorder.finalResult();
  return { ...result, sessionId: parsedRecorder.sessionId };
}
