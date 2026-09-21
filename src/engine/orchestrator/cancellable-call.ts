import type { WorkflowSinks } from './types.js';

// Cancelling from the UI must end the call in flight, not the workflow: the sink's handler
// aborts this call's controller only, and is cleared the moment the call settles so a later
// phase never inherits it.
export async function withPerCallAbort<T>(opts: {
  sinks: Pick<WorkflowSinks, 'setAbortHandler'> | undefined;
  signal: AbortSignal | undefined;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const { sinks, signal, run } = opts;
  const call = new AbortController();
  const composed = signal === undefined ? call.signal : AbortSignal.any([signal, call.signal]);
  sinks?.setAbortHandler(() => call.abort());
  try {
    return await run(composed);
  } finally {
    sinks?.setAbortHandler(null);
  }
}
