import type { ChildProcess } from 'node:child_process';
import type { BoundedOutput, BoundedOutputMetadata } from '../bounded-output.js';

export const DEFAULT_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_STDERR_MAX_BYTES = 256 * 1024;

export type SpawnPipeFatalState = 'output-budget-breach' | 'protocol-failure' | 'callback-failure';

export interface SpawnPipeFatalSignal {
  state: SpawnPipeFatalState;
  remediation: string;
}

export interface SpawnPipeFatalOutcome extends SpawnPipeFatalSignal {
  stdout: string;
  stderr: string;
  stdoutMetadata: BoundedOutputMetadata;
  stderrMetadata: BoundedOutputMetadata;
}

export type SpawnPipeCallbackResult = SpawnPipeFatalSignal | undefined;

/** How a child that broke its prompt closed; absent when it did not close within the grace. */
export type SpawnPipeExit = Readonly<{ code: number | null }>;

export interface SpawnIdleOptions {
  warnMs: number;
  /** Opt-in cut on byte silence; unset, the watchdog only warns. */
  killMs?: number | undefined;
  /** Names the subject in the idle diagnostic so it need not carry the resolved binary path. */
  label?: string | undefined;
  onWarn?: ((silentMs: number) => void) | undefined;
  onClear?: (() => void) | undefined;
}

export type SpawnStdinWriter = Readonly<{
  write: (text: string) => Promise<void>;
  end: () => void;
}>;

export interface SpawnPipeOptions<T> {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  detached?: boolean | undefined;
  stdin?: string | undefined;
  stdinOptional?: boolean | undefined;
  onStdinReady?: ((writer: SpawnStdinWriter) => void) | undefined;
  signal?: AbortSignal | undefined;
  idle?: SpawnIdleOptions | undefined;
  outputBudgetBytes?: number | undefined;
  partialStdoutMaxBytes?: number | undefined;
  partialStderrMaxBytes?: number | undefined;
  onStdout: (chunk: string) => SpawnPipeCallbackResult;
  onStderr: (chunk: string) => SpawnPipeCallbackResult;
  onClose: (code: number | null, signal: string | null) => T | Promise<T>;
  onError?: ((err: NodeJS.ErrnoException) => Error | null) | undefined;
  onSpawned?: ((proc: ChildProcess) => void) | undefined;
}

export interface IdleTimers {
  warned: boolean;
  warn: NodeJS.Timeout | undefined;
  kill: NodeJS.Timeout | undefined;
}

/** One spawned child from its spawn to its outcome; every step reads and writes it in place. */
export interface SpawnRun<T> {
  opts: SpawnPipeOptions<T>;
  proc: ChildProcess;
  phase: 'active' | 'draining' | 'terminating' | 'settled';
  exit: SpawnPipeExit | undefined;
  closed: PromiseWithResolvers<void>;
  stdinWriteComplete: boolean;
  stdinEndComplete: boolean;
  outputBytesSeen: number;
  outputBudgetBytes: number | undefined;
  partialStdout: BoundedOutput;
  partialStderr: BoundedOutput;
  idleTimers: IdleTimers;
  removeAbortListener: (() => void) | undefined;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
