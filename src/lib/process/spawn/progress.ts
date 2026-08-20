import type { BoundedOutputMetadata } from '../bounded-output.js';
import { createBoundedOutput } from '../bounded-output.js';
import { isENOENT, processError } from '../errors.js';
import {
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  type SpawnIdleOptions,
  spawnPipe,
} from './lifecycle.js';

export interface SpawnResult {
  output: string;
  code: number;
  timedOut: boolean;
  stderr: string;
  outputMetadata?: BoundedOutputMetadata | undefined;
  stderrMetadata?: BoundedOutputMetadata | undefined;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  timeout: number;
  onProgress: (text: string) => void;
  onStderr?: ((chunk: string) => void) | undefined;
  stdinInput?: string | undefined;
  notFoundMessage?: string | undefined;
  signal?: AbortSignal | undefined;
  idle?: SpawnIdleOptions | undefined;
  outputMaxBytes?: number | undefined;
  stderrMaxBytes?: number | undefined;
  ledger?: boolean | undefined;
}

export async function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  const output = createBoundedOutput({
    maxBytes: opts.outputMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
    policy: 'prefix-tail',
  });
  const stderrOutput = createBoundedOutput({
    maxBytes: opts.stderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
    policy: 'tail',
  });
  const timeoutSignal = AbortSignal.timeout(opts.timeout);
  const signal =
    opts.signal === undefined ? timeoutSignal : AbortSignal.any([opts.signal, timeoutSignal]);
  let timeoutExitCode: number | null = null;

  try {
    return await spawnPipe({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      ledger: opts.ledger,
      stdin: opts.stdinInput,
      signal,
      idle: opts.idle,
      onSpawned: (proc) => {
        proc.once('close', (code) => {
          timeoutExitCode = code;
        });
      },
      onStdout: (chunk) => {
        output.append(chunk);
        opts.onProgress(chunk);
      },
      onStderr: (chunk) => {
        stderrOutput.append(chunk);
        opts.onStderr?.(chunk);
      },
      onClose: (code) => {
        const outputSnapshot = output.snapshot();
        const stderrSnapshot = stderrOutput.snapshot();
        if (code === 127) {
          throw processError.notFound(opts.command, opts.notFoundMessage);
        }
        if (code !== 0) {
          throw processError.exitCode({
            command: opts.command,
            code,
            stderr: stderrSnapshot.text,
            output: outputSnapshot.text,
          });
        }
        return {
          output: outputSnapshot.text,
          code: 0,
          timedOut: false,
          stderr: stderrSnapshot.text,
          outputMetadata: outputSnapshot,
          stderrMetadata: stderrSnapshot,
        };
      },
      onError: (err) => {
        if (opts.notFoundMessage && isENOENT(err))
          return processError.notFound(opts.command, opts.notFoundMessage);
        return null;
      },
    });
  } catch (err: unknown) {
    if (err !== timeoutSignal.reason) throw err;

    const outputSnapshot = output.snapshot();
    const stderrSnapshot = stderrOutput.snapshot();
    return {
      output: outputSnapshot.text,
      code: timeoutExitCode ?? 1,
      timedOut: true,
      stderr: stderrSnapshot.text,
      outputMetadata: outputSnapshot,
      stderrMetadata: stderrSnapshot,
    };
  }
}
