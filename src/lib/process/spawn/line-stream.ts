import { createBoundedOutput, type BoundedOutputMetadata } from '../bounded-output.js';
import { isENOENT, processError } from '../errors.js';
import { createLineBuffer } from '../line-buffer.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  type SpawnIdleOptions,
  spawnPipe,
} from './lifecycle.js';

export async function spawnWithStdin(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  onLine: (line: string) => void;
  onStdoutLineOverflow?:
    | ((overflow: { lineBytes: number; maxLineBytes: number }) => void)
    | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  errorDetail?: (() => string | undefined) | undefined;
  notFoundMessage?: string | undefined;
  signal?: AbortSignal | undefined;
  idle?: SpawnIdleOptions | undefined;
  outputMaxBytes?: number | undefined;
  stderrMaxBytes?: number | undefined;
  stdoutLineMaxBytes?: number | undefined;
}): Promise<{
  text: string;
  stderrOutput: string;
  code: number;
  textMetadata?: BoundedOutputMetadata | undefined;
  stderrMetadata?: BoundedOutputMetadata | undefined;
}> {
  const rawText = createBoundedOutput({
    maxBytes: opts.outputMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
    policy: 'prefix-tail',
  });
  const stderrOutput = createBoundedOutput({
    maxBytes: opts.stderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
    policy: 'tail',
  });
  const stdoutBuf = createLineBuffer(opts.onLine, {
    maxLineBytes: opts.stdoutLineMaxBytes ?? DEFAULT_PROCESS_LINE_MAX_BYTES,
    onOverflow: (overflow) => opts.onStdoutLineOverflow?.(overflow),
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
    onStdout: (chunk) => {
      rawText.append(chunk);
      stdoutBuf.push(chunk);
    },
    onStderr: (chunk) => {
      stderrOutput.append(chunk);
      opts.onStderr?.(chunk);
    },
    onError: (err) =>
      isENOENT(err) ? processError.notFound(opts.command, opts.notFoundMessage) : null,
    onClose: (code) => {
      stdoutBuf.flush();
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
