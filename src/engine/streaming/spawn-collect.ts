import type { OutputFormat } from '../../core/schemas/enums.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { ParsedLine } from '../runners/types.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import { getLineParser } from './output-parsers.js';

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

  let sessionId: string | null = null;
  const recorder = createRunnerCallRecorder({ context, onEvent: opts.onCallEvent });

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
        const parsed = parseLine(line);
        if (parsed.text) {
          recorder.text({ channel: parsed.isResult ? 'result' : 'stdout', text: parsed.text });
          opts.onText?.(parsed.text);
        }
        if (parsed.usage) {
          recorder.usage({
            usage: parsed.usage,
            semantics: parsed.isResult ? 'final' : 'delta',
          });
        }
        if (parsed.sessionId && parsed.sessionId !== sessionId) {
          sessionId = parsed.sessionId;
          recorder.sessionId({ nativeSessionId: parsed.sessionId });
          opts.onSessionId?.(parsed.sessionId);
        }
        if (parsed.toolUse) {
          for (const toolUse of parsed.toolUse) {
            recorder.toolUseDone({
              toolUse: { id: null, name: toolUse.name, input: toolUse.input },
            });
          }
        }
        if (parsed.isError) {
          recorder.finishFailed({
            status: 'failed',
            error: {
              code: 'runner_result_error',
              message: parsed.text ?? 'Runner result failed',
            },
          });
        }
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
    recorder.finishCompleted({ nativeSessionId: sessionId });
  }

  const result = recorder.finalResult();
  return { ...result, sessionId };
}
