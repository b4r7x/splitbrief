import { createBoundedOutput, type BoundedOutputMetadata } from '../bounded-output.js';
import { isENOENT, processError } from '../errors.js';
import { createLineBuffer } from '../line-buffer.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  isFatalSignal,
  type SpawnIdleOptions,
  type SpawnPipeFatalSignal,
  spawnPipe,
} from './lifecycle.js';

type LineStreamCallback<T> =
  | ((value: T) => void)
  | ((value: T) => SpawnPipeFatalSignal | undefined);

export async function spawnWithStdin(opts: {
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  onLine: LineStreamCallback<string>;
  onStdoutLineOverflow?:
    | LineStreamCallback<{ lineBytes: number; maxLineBytes: number }>
    | undefined;
  onStderr?: LineStreamCallback<string> | undefined;
  errorDetail?: (() => string | undefined) | undefined;
  notFoundMessage?: string | undefined;
  signal?: AbortSignal | undefined;
  idle?: SpawnIdleOptions | undefined;
  outputMaxBytes?: number | undefined;
  stderrMaxBytes?: number | undefined;
  stdoutLineMaxBytes?: number | undefined;
  outputBudgetBytes?: number | undefined;
}): Promise<{
  text: string;
  stderrOutput: string;
  code: number;
  textMetadata?: BoundedOutputMetadata | undefined;
  stderrMetadata?: BoundedOutputMetadata | undefined;
}> {
  const stdoutMaxBytes = opts.outputMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES;
  const stderrMaxBytes = opts.stderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES;
  const rawText = createBoundedOutput({
    maxBytes: stdoutMaxBytes,
    policy: 'prefix-tail',
  });
  const stderrOutput = createBoundedOutput({
    maxBytes: stderrMaxBytes,
    policy: 'tail',
  });
  const stdoutBuf = createLineBuffer(
    (line) => {
      const result = opts.onLine(line);
      return isFatalSignal(result) ? result : undefined;
    },
    {
      maxLineBytes: opts.stdoutLineMaxBytes ?? DEFAULT_PROCESS_LINE_MAX_BYTES,
      onOverflow: (overflow) => {
        const result = opts.onStdoutLineOverflow?.(overflow);
        return isFatalSignal(result) ? result : undefined;
      },
    },
  );

  return spawnPipe({
    command: opts.command,
    args: [...opts.args],
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdin: opts.stdin,
    signal: opts.signal,
    idle: opts.idle,
    outputBudgetBytes: opts.outputBudgetBytes,
    partialStdoutMaxBytes: stdoutMaxBytes,
    partialStderrMaxBytes: stderrMaxBytes,
    onStdout: (chunk) => {
      rawText.append(chunk);
      const callbackResult = stdoutBuf.push(chunk);
      return isFatalSignal(callbackResult) ? callbackResult : undefined;
    },
    onStderr: (chunk) => {
      stderrOutput.append(chunk);
      const callbackResult = opts.onStderr?.(chunk);
      return isFatalSignal(callbackResult) ? callbackResult : undefined;
    },
    onError: (err) =>
      isENOENT(err) ? processError.notFound(opts.command, opts.notFoundMessage) : null,
    onClose: (code) => {
      const flushResult = stdoutBuf.flush();
      if (isFatalSignal(flushResult)) throw flushResult;
      const textSnapshot = rawText.snapshot();
      const stderrSnapshot = stderrOutput.snapshot();

      if (code === 127) {
        throw processError.notFound(opts.command, opts.notFoundMessage);
      }

      if (code !== 0) {
        throw processError.exitCode({
          command: opts.command,
          code,
          stderr: stderrSnapshot.text,
          output: textSnapshot.text,
          detail: stderrSnapshot.text.trim() ? undefined : opts.errorDetail?.(),
        });
      }

      return {
        text: textSnapshot.text,
        stderrOutput: stderrSnapshot.text,
        code: code ?? 0,
        textMetadata: textSnapshot,
        stderrMetadata: stderrSnapshot,
      };
    },
  });
}
