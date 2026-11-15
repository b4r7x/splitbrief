import type { ChildProcess } from 'node:child_process';
import type { HeadTailEventLog } from '../../../calls/output-limit.js';
import type { RunnerCallRecorder } from '../../../calls/recorder/types.js';
import type { SteeringPort } from '../../../calls/steering.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../../calls/types.js';
import type {
  CliInvocation,
  CliProcessAdapter,
  CliProtocolEvent,
  CliSteeringSession,
} from '../contract.js';

/**
 * Inspects one tool call as the stream reports it: once when its start and its
 * end carry the same input, and again when the end brings an input the start
 * lacked — Claude Code opens a call with none. A returned error stops the call
 * through the same abort that ends a cancelled one and becomes the call's
 * failure, so a tool call that crossed the caller's boundary is not left to
 * run on.
 */
export type ToolUseGuard = (
  toolUse: Readonly<{ name: string; input: Readonly<Record<string, unknown>> }>,
) => Readonly<{ code: string; message: string }> | null;

export type InvokeProcessCliContext = Readonly<{
  invocation: CliInvocation;
  prompt: string;
  steering?: SteeringPort | undefined;
  installedVersion?: string | undefined;
  callContext: RunnerCallContext;
  /**
   * Liveness is measured from process output, not from recorded events: a
   * runner can think for minutes while emitting frames that record nothing.
   */
  idle?: Readonly<{ warnMs: number; killMs?: number | undefined }> | undefined;
  /** The seat's opt-in `maxToolCalls`; unset, no tool-call count ends the call. */
  maxToolCalls?: number | undefined;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  toolUseGuard?: ToolUseGuard | undefined;
  /**
   * Optional lifecycle hook used by callers that need to observe the exact spawned child.
   * `spawnPipe` owns the failure boundary: a throw is converted to callback-failure and the
   * process tree is reaped before this invocation resolves.
   */
  onSpawned?: ((process: ChildProcess) => void) | undefined;
}>;

export type ProcessClose = Readonly<{
  exitCode: number | null;
  signal: string | null;
  stderr: string;
}>;

/**
 * What the steps of one CLI call change in place. A callback of the tool's output, of the steering
 * session or of a timer reads the value of the moment it runs.
 */
type ProcessCallState = {
  /** A steering session that brings its own credential values replaces it before the spawn. */
  recorder: RunnerCallRecorder;
  steeringSession: CliSteeringSession | undefined;
  /** Releases the steering port; the first close of the admission takes it. */
  detach: (() => void) | undefined;
  admissionClosed: boolean;
  /** The last stdout line that the parser read as protocol events. */
  stdoutLastLine: string;
  /** The stdout text after the last line break; the close flushes it and empties it. */
  stdoutTailCarry: string;
  stderr: string;
  /** A usage limit or a sign-out on stderr that stopped the tool before its terminal result. */
  storedHalt: Readonly<{ code: string; message: string }> | undefined;
  terminalSeen: boolean;
  graceTimer: NodeJS.Timeout | undefined;
  guardFailure: ReturnType<ToolUseGuard>;
  removeTransportListener: (() => void) | undefined;
};

/** One CLI call from its prelaunch to its result: what its steps read, and its state. */
export type ProcessCall = Readonly<{
  adapter: CliProcessAdapter;
  context: InvokeProcessCliContext;
  /** The values each record redacts; a steering session adds its own. */
  credentialValues: string[];
  /** The caller's event callback; a throw marks `callback.failed`. */
  recordEvent: (event: RunnerCallEvent) => void;
  protocolEvents: HeadTailEventLog<CliProtocolEvent>;
  /** The input of each tool use the guard read, by its id. */
  inspectedInputs: Map<string, string>;
  /** Aborts on a stop by the user, the timeout, the guard, the tool-call limit or a steering transport failure. */
  signal: AbortSignal;
  guard: AbortController;
  limit: AbortController;
  transport: AbortController;
  /** Stops the tool once the call holds its result, with `settled` as the reason. */
  settle: AbortController;
  settled: DOMException;
  /**
   * Set when a callback of the caller throws. It exists before the recorder, because the first
   * record of the recorder already reaches the caller's callback.
   */
  callback: { failed: boolean };
  state: ProcessCallState;
}>;
