import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { RunnerCallEvent } from './types.js';
import { RUNNER_CALL_OUTPUT_MAX_BYTES, RUNNER_CALL_OUTPUT_MAX_EVENTS } from './output-limit.js';
import { isRunnerCallTerminalEvent } from './status.js';

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

export function createRunnerAttemptCallbackBuffer(
  callbacks: RunnerAttemptCallbacks,
): RunnerAttemptCallbackBuffer {
  const pending: BufferedCallback[] = [];
  let pendingBytes = 0;
  let pendingEvents = 0;
  let dropping = false;
  let flushed = false;

  function add(
    callback: BufferedCallback,
    opts: { bytes: number; keepAfterLimit?: boolean | undefined },
  ): void {
    if (flushed) {
      callback();
      return;
    }
    const wouldExceed =
      pendingEvents >= CALLBACK_BUFFER_MAX_EVENTS ||
      pendingBytes + opts.bytes > CALLBACK_BUFFER_MAX_BYTES;
    if ((dropping || wouldExceed) && opts.keepAfterLimit !== true) {
      dropping = true;
      return;
    }
    pendingBytes += opts.bytes;
    pendingEvents += 1;
    pending.push(callback);
  }

  return {
    callbacks: {
      onOutput: (text) =>
        add(() => callbacks.onOutput(text), { bytes: Buffer.byteLength(text, 'utf8') }),
      onSessionId: (id) =>
        add(() => callbacks.onSessionId?.(id), { bytes: Buffer.byteLength(id, 'utf8') }),
      onQuestion: (questions) =>
        add(() => callbacks.onQuestion?.(questions), {
          bytes: Buffer.byteLength(JSON.stringify(questions), 'utf8'),
        }),
      onCallEvent: (event) =>
        add(() => callbacks.onCallEvent?.(event), {
          bytes: Buffer.byteLength(JSON.stringify(event), 'utf8'),
          keepAfterLimit: isRunnerCallTerminalEvent(event),
        }),
    },
    flush(): void {
      if (flushed) return;
      flushed = true;
      for (const callback of pending) callback();
      pending.length = 0;
    },
  };
}
