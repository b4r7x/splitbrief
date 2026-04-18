/**
 * Yield to the event loop and microtask queue.
 *
 * Default (`ms=0`) waits one macrotask via `setImmediate`, then flushes
 * microtasks. A positive `ms` waits that many milliseconds via `setTimeout`.
 *
 * Use this to let React/Ink effects settle, for async state updates to
 * propagate, or before asserting on post-render state.
 */
export function tick(ms = 0): Promise<void> {
  if (ms > 0) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }).then(() => Promise.resolve());
  }
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  }).then(() => Promise.resolve());
}
