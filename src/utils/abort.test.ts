import { describe, expect, it } from 'vitest';
import { composeAbortSignal } from './abort.js';

describe('composeAbortSignal', () => {
  it('returns undefined when neither signal nor timeout is provided', () => {
    expect(composeAbortSignal(undefined, undefined)).toBeUndefined();
  });

  it('returns the caller signal unchanged when no timeout is provided', () => {
    const controller = new AbortController();
    expect(composeAbortSignal(controller.signal, undefined)).toBe(controller.signal);
  });

  it('returns a timeout-backed signal when only a timeout is provided', () => {
    const composed = composeAbortSignal(undefined, 10_000);
    expect(composed).toBeInstanceOf(AbortSignal);
    expect(composed?.aborted).toBe(false);
  });

  it('aborts when the caller signal aborts', () => {
    const controller = new AbortController();
    const composed = composeAbortSignal(controller.signal, 10_000);
    expect(composed?.aborted).toBe(false);
    controller.abort();
    expect(composed?.aborted).toBe(true);
  });

  it('aborts when the timeout elapses', async () => {
    const controller = new AbortController();
    const composed = composeAbortSignal(controller.signal, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(composed?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });
});
