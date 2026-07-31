import { createBoundedOutput, type BoundedOutputMetadata } from '../bounded-output.js';
import { isENOENT, processError } from '../errors.js';
import { createLineBuffer } from '../line-buffer.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  type SpawnIdleOptions,
  type SpawnPipeFatalSignal,
  spawnPipe,
} from './lifecycle.js';

type LineStreamCallback<T> =
  | ((value: T) => void)
  | ((value: T) => SpawnPipeFatalSignal | undefined);

function isFatalSignal(value: unknown): value is SpawnPipeFatalSignal {
  if (typeof value !== 'object' || value === null) return false;
  if (!('state' in value) || !('remediation' in value)) return false;
  return (
    (value.state === 'output-budget-breach' ||
      value.state === 'protocol-failure' ||
      value.state === 'callback-failure') &&
    typeof value.remediation === 'string'
  );
}

export async function spawnWithStdin(opts: {
  command: string;
  args: string[];
  cwd: string;
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
  let stdoutBytesSeen = 0;
  let stderrBytesSeen = 0;

  const byteLimitSignal = (channel: 'stdout' | 'stderr', maxBytes: number) => ({
    state: 'output-budget-breach' as const,
    remediation: `${channel} exceeded its ${maxBytes}-byte output budget. Reduce the requested output or increase the configured output budget.`,
  });

  return spawnPipe({
    command: opts.command,
    args: opts.args,
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
      stdoutBytesSeen += Buffer.byteLength(chunk, 'utf8');
      const callbackResult = stdoutBuf.push(chunk);
      if (isFatalSignal(callbackResult)) return callbackResult;
      if (stdoutBytesSeen > stdoutMaxBytes) return byteLimitSignal('stdout', stdoutMaxBytes);
      return undefined;
    },
    onStderr: (chunk) => {
      stderrOutput.append(chunk);
      stderrBytesSeen += Buffer.byteLength(chunk, 'utf8');
      const callbackResult = opts.onStderr?.(chunk);
      if (isFatalSignal(callbackResult)) return callbackResult;
      if (stderrBytesSeen > stderrMaxBytes) return byteLimitSignal('stderr', stderrMaxBytes);
      return undefined;
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
