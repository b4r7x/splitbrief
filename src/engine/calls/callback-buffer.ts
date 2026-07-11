import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { RunnerCallContext, RunnerCallEvent } from './types.js';
import { RUNNER_CALL_OUTPUT_MAX_BYTES, RUNNER_CALL_OUTPUT_MAX_EVENTS } from './output-limit.js';
import { isRunnerCallTerminalEvent } from './status.js';
import { normalizeRunnerCallWarning } from './warnings.js';

export interface RunnerAttemptCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}

export interface RunnerAttemptCallbackBuffer {
  callbacks: RunnerAttemptCallbacks;
  flush(): void;
}

type BufferedCallback = () => void;
const CALLBACK_BUFFER_MAX_BYTES = RUNNER_CALL_OUTPUT_MAX_BYTES * 3;
const CALLBACK_BUFFER_MAX_EVENTS = RUNNER_CALL_OUTPUT_MAX_EVENTS * 3;
const CALLBACK_BUFFER_OVERFLOW_WARNING_CODE = 'callback_buffer_overflow';
const CALLBACK_BUFFER_OVERFLOW_WARNING_MESSAGE = `Runner callback buffer exceeded ${CALLBACK_BUFFER_MAX_EVENTS} events or ${CALLBACK_BUFFER_MAX_BYTES} bytes; non-terminal callbacks were dropped.`;

export function createRunnerAttemptCallbackBuffer(
  callbacks: RunnerAttemptCallbacks,
): RunnerAttemptCallbackBuffer {
  const pending: BufferedCallback[] = [];
  let pendingBytes = 0;
  let pendingEvents = 0;
  let dropping = false;
  let flushed = false;
  let latestCallContext: RunnerCallContext | null = null;
  let overflowWarningPending = false;
  let overflowWarningQueued = false;

  function add(
    callback: BufferedCallback,
    opts: { bytes: number; keepAfterLimit?: boolean | undefined },
  ): boolean {
    if (flushed) {
      callback();
      return true;
    }
    const wouldExceed =
      pendingEvents >= CALLBACK_BUFFER_MAX_EVENTS ||
      pendingBytes + opts.bytes > CALLBACK_BUFFER_MAX_BYTES;
    if ((dropping || wouldExceed) && opts.keepAfterLimit !== true) {
      dropping = true;
      return false;
    }
    pendingBytes += opts.bytes;
    pendingEvents += 1;
    pending.push(callback);
    return true;
  }

  function queueOverflowWarningIfPossible(): void {
    if (
      latestCallContext === null ||
      callbacks.onCallEvent === undefined ||
      !overflowWarningPending ||
      overflowWarningQueued
    ) {
      return;
    }
    const event: RunnerCallEvent = {
      type: 'call_warning',
      ts: Date.now(),
      ...latestCallContext,
      warning: normalizeRunnerCallWarning({
        code: CALLBACK_BUFFER_OVERFLOW_WARNING_CODE,
        severity: 'warning',
        source: 'system',
        surface: 'activity',
        message: CALLBACK_BUFFER_OVERFLOW_WARNING_MESSAGE,
      }),
    };
    overflowWarningQueued = true;
    overflowWarningPending = false;
    add(() => callbacks.onCallEvent?.(event), {
      bytes: Buffer.byteLength(JSON.stringify(event), 'utf8'),
      keepAfterLimit: true,
    });
  }

  function markOverflow(): void {
    if (overflowWarningQueued) return;
    overflowWarningPending = true;
    queueOverflowWarningIfPossible();
  }

  function addOrMarkOverflow(
    callback: BufferedCallback,
    opts: { bytes: number; keepAfterLimit?: boolean | undefined },
  ): void {
    if (!add(callback, opts)) markOverflow();
  }

  function captureCallContext(event: RunnerCallEvent): void {
    latestCallContext = {
      callId: event.callId,
      role: event.role,
      backendKind: event.backendKind,
      ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
      ...(event.model !== undefined && { model: event.model }),
      ...(event.attempt !== undefined && { attempt: event.attempt }),
    };
  }

  return {
    callbacks: {
      onOutput: (text) => {
        addOrMarkOverflow(() => callbacks.onOutput(text), {
          bytes: Buffer.byteLength(text, 'utf8'),
        });
      },
      onSessionId: (id) => {
        addOrMarkOverflow(() => callbacks.onSessionId?.(id), {
          bytes: Buffer.byteLength(id, 'utf8'),
        });
      },
      onQuestion: (questions) => {
        addOrMarkOverflow(() => callbacks.onQuestion?.(questions), {
          bytes: Buffer.byteLength(JSON.stringify(questions), 'utf8'),
        });
      },
      onCallEvent: (event) => {
        captureCallContext(event);
        if (event.type === 'call_stalled' || event.type === 'call_stall_cleared') {
          callbacks.onCallEvent?.(event);
          return;
        }
        queueOverflowWarningIfPossible();
        addOrMarkOverflow(() => callbacks.onCallEvent?.(event), {
          bytes: Buffer.byteLength(JSON.stringify(event), 'utf8'),
          keepAfterLimit: isRunnerCallTerminalEvent(event),
        });
      },
    },
    flush(): void {
      if (flushed) return;
      flushed = true;
      for (const callback of pending) callback();
      pending.length = 0;
    },
  };
}
