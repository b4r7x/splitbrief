import type { BoundedOutputMetadata } from '../bounded-output.js';
import { createBoundedOutput } from '../bounded-output.js';
import { processError } from '../errors.js';
import { createCommandEnv } from './child-env.js';
import {
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  spawnPipe,
} from './lifecycle.js';

export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string | undefined;
    timeout?: number | undefined;
    label?: string | undefined;
    signal?: AbortSignal | undefined;
    outputMaxBytes?: number | undefined;
    stderrMaxBytes?: number | undefined;
  },
): Promise<{
  stdout: string;
  stderr: string;
  code: 0;
  stdoutMetadata?: BoundedOutputMetadata | undefined;
  stderrMetadata?: BoundedOutputMetadata | undefined;
}> {
  const timeout = options?.timeout;
  const stdout = createBoundedOutput({
    maxBytes: options?.outputMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
    policy: 'prefix-tail',
  });
  const stderr = createBoundedOutput({
    maxBytes: options?.stderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
    policy: 'tail',
  });
  const timeoutSignal = timeout === undefined ? undefined : AbortSignal.timeout(timeout);
  const signal =
    options?.signal === undefined || timeoutSignal === undefined
      ? (timeoutSignal ?? options?.signal)
      : AbortSignal.any([options.signal, timeoutSignal]);

  try {
    return await spawnPipe({
      command,
      args,
      cwd: options?.cwd,
      env: createCommandEnv(),
      detached: true,
      signal,
      onStdout: (chunk) => {
        stdout.append(chunk);
      },
      onStderr: (chunk) => {
        stderr.append(chunk);
      },
      onClose: (code) => {
        const stdoutSnapshot = stdout.snapshot();
        const stderrSnapshot = stderr.snapshot();
        if (code !== 0) {
          throw processError.exitCode({
            command,
            label: options?.label,
            code,
            stderr: stderrSnapshot.text,
            output: stdoutSnapshot.text,
            truncated: stdoutSnapshot.truncated || stderrSnapshot.truncated,
          });
        }
        return {
          stdout: stdoutSnapshot.text,
          stderr: stderrSnapshot.text,
          code: 0,
          stdoutMetadata: stdoutSnapshot,
          stderrMetadata: stderrSnapshot,
        };
      },
      onError: () => null,
    });
  } catch (err: unknown) {
    if (timeout === undefined || err !== timeoutSignal?.reason) throw err;

    const stdoutSnapshot = stdout.snapshot();
    const stderrSnapshot = stderr.snapshot();
    throw processError.timeout({
      command,
      label: options?.label,
      timeoutMs: timeout,
      output: stderrSnapshot.text || stdoutSnapshot.text,
    });
  }
}
