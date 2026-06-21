import { spawn, type ChildProcess } from 'node:child_process';
import { error } from '../../utils/error.js';
import { createBoundedOutput, type BoundedOutputMetadata } from './bounded-output.js';
import { isENOENT, processError } from './errors.js';
import { createLineBuffer } from './line-buffer.js';
import { registerProcess, unregisterProcess, killProcess, abortProcess } from './registry.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_STDERR_MAX_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_LINE_MAX_BYTES = 1024 * 1024;

export const spawnError = {
  streamsUnavailable: () => error('process-streams-unavailable', 'Process streams not available'),
} as const;

interface SpawnPipeOptions<T> {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  detached?: boolean | undefined;
  stdin?: string | undefined;
  signal?: AbortSignal | undefined;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onClose: (code: number | null, signal: string | null) => T | Promise<T>;
  onError?: ((err: NodeJS.ErrnoException) => Error | null) | undefined;
  onSpawned?: ((proc: ChildProcess) => void) | undefined;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function spawnPipe<T>(opts: SpawnPipeOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    let proc: ChildProcess;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: opts.detached ?? false,
      });
    } catch (err: unknown) {
      fail(err);
      return;
    }

    registerProcess(proc, { group: opts.detached ?? false });
    opts.onSpawned?.(proc);

    if (opts.signal) {
      abortProcess(proc, opts.signal, { group: opts.detached ?? false });
    }

    const { stdout, stderr, stdin } = proc;
    if (!stdout || !stderr || !stdin) {
      unregisterProcess(proc);
      fail(spawnError.streamsUnavailable());
      return;
    }

    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', (chunk: string) => opts.onStdout(chunk));
    stderr.on('data', (chunk: string) => opts.onStderr(chunk));

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      const mapped = opts.onError?.(err);
      fail(mapped ?? err);
    });

    proc.on('close', (code, signal) => {
      unregisterProcess(proc);
      if (opts.signal?.aborted) {
        fail(abortError());
        return;
      }
      try {
        Promise.resolve(opts.onClose(code, signal)).then(done, fail);
      } catch (err: unknown) {
        fail(err);
      }
    });

    stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      unregisterProcess(proc);
      fail(err);
    });

    if (opts.stdin === undefined) {
      stdin.end();
      return;
    }

    if (stdin.write(opts.stdin)) {
      stdin.end();
      return;
    }

    stdin.once('drain', () => stdin.end());
  });
}

export function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string | undefined;
    timeout?: number | undefined;
    label?: string | undefined;
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

  return spawnPipe({
    command,
    args,
    cwd: options?.cwd,
    onSpawned: (proc) => {
      if (timeoutSignal.aborted) {
        killProcess(proc);
        return;
      }
      timeoutSignal.addEventListener('abort', () => killProcess(proc), { once: true });
    },
    onStdout: (chunk) => {
      stdout.append(chunk);
    },
    onStderr: (chunk) => {
      stderr.append(chunk);
    },
    onClose: (code) => {
      const stdoutSnapshot = stdout.snapshot();
      const stderrSnapshot = stderr.snapshot();
      if (timeoutSignal.aborted) {
        throw processError.timeout({
          command,
          label: options?.label,
          timeoutMs: timeout,
          output: stderrSnapshot.text || stdoutSnapshot.text,
        });
      }
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
}

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
  outputMaxBytes?: number | undefined;
  stderrMaxBytes?: number | undefined;
}

export function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  const output = createBoundedOutput({
    maxBytes: opts.outputMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
    policy: 'prefix-tail',
  });
  const stderrOutput = createBoundedOutput({
    maxBytes: opts.stderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
    policy: 'tail',
  });
  const timeoutSignal = AbortSignal.timeout(opts.timeout);

  return spawnPipe({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdin: opts.stdinInput,
    signal: opts.signal,
    onSpawned: (proc) => {
      if (timeoutSignal.aborted) {
        killProcess(proc, { group: true });
        return;
      }
      timeoutSignal.addEventListener('abort', () => killProcess(proc, { group: true }), {
        once: true,
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
      if (timeoutSignal.aborted) {
        return {
          output: outputSnapshot.text,
          code: code ?? 1,
          timedOut: true,
          stderr: stderrSnapshot.text,
          outputMetadata: outputSnapshot,
          stderrMetadata: stderrSnapshot,
        };
      }
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
}

export async function spawnWithShellFallback(opts: SpawnOptions): Promise<SpawnResult> {
  const { notFoundMessage: _drop, ...firstAttemptOpts } = opts;
  void _drop;
  try {
    return await spawnWithTimeout(firstAttemptOpts);
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;

    const userShell = process.env['SHELL'] ?? '/bin/bash';
    const fullCommand = [opts.command, ...opts.args]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');
    return spawnWithTimeout({ ...opts, command: userShell, args: ['-c', fullCommand] });
  }
}

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
