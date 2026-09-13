import { describe, expect, it } from 'vitest';
import { withPerCallAbort } from './cancellable-call.js';

function recordingSinks() {
  const installed: ((() => void) | null)[] = [];
  return {
    installed,
    sinks: {
      setAbortHandler: (handler: (() => void) | null) => {
        installed.push(handler);
      },
    },
  };
}

describe('withPerCallAbort', () => {
  it('aborts only the call when the installed handler fires', async () => {
    const workflow = new AbortController();
    const { installed, sinks } = recordingSinks();
    let callSignal: AbortSignal | undefined;

    const value = await withPerCallAbort({
      sinks,
      signal: workflow.signal,
      run: async (signal) => {
        callSignal = signal;
        installed[0]?.();
        return 'done';
      },
    });

    expect(value).toBe('done');
    expect(callSignal?.aborted).toBe(true);
    expect(workflow.signal.aborted).toBe(false);
  });

  it('propagates the workflow signal to the call', async () => {
    const workflow = new AbortController();
    const { sinks } = recordingSinks();
    let callSignal: AbortSignal | undefined;

    await withPerCallAbort({
      sinks,
      signal: workflow.signal,
      run: async (signal) => {
        callSignal = signal;
      },
    });
    workflow.abort();

    expect(callSignal?.aborted).toBe(true);
  });

  it('clears the handler whether the call resolves or throws', async () => {
    const { installed, sinks } = recordingSinks();

    await withPerCallAbort({ sinks, signal: undefined, run: async () => undefined });
    expect(installed.at(-1)).toBeNull();

    await expect(
      withPerCallAbort({
        sinks,
        signal: undefined,
        run: async () => {
          throw new Error('call failed');
        },
      }),
    ).rejects.toThrow('call failed');
    expect(installed.at(-1)).toBeNull();
  });

  it('runs without sinks', async () => {
    let callSignal: AbortSignal | undefined;

    const value = await withPerCallAbort({
      sinks: undefined,
      signal: undefined,
      run: async (signal) => {
        callSignal = signal;
        return 7;
      },
    });

    expect(value).toBe(7);
    expect(callSignal?.aborted).toBe(false);
  });
});
