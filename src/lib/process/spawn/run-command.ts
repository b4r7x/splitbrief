import type { BoundedOutputMetadata } from '../bounded-output.js';
import { createBoundedOutput } from '../bounded-output.js';
import { processError } from '../errors.js';
import {
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  spawnPipe,
} from './lifecycle.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

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
  const timeout = options?.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const stdout = createBoundedOutput({
    maxBytes: options?.outputMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
    policy: 'prefix-tail',
  });
  const stderr = createBoundedOutput({
    maxBytes: options?.stderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
    policy: 'tail',
  });
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal =
    options?.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);

  try {
    return await spawnPipe({
      command,
      args,
      cwd: options?.cwd,
      detached: true,
      // Short-lived probe/validation/git commands skip the runner-pid ledger: at
      // dozens of spawns per validation pipeline, the per-spawn sync `ps` exec and
      // jsonl rewrites would block the TUI event loop for no recovery benefit.
      ledger: false,
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
        if (code === 127) {
          throw processError.notFound(command);
        }
        if (code !== 0) {
          throw processError.exitCode({
            command,
            label: options?.label,
            code,
            stderr: stderrSnapshot.text,
            output: stdoutSnapshot.text,
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
    if (err !== timeoutSignal.reason) throw err;

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
