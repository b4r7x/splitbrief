import { vi } from 'vitest';

// vi.waitFor gives up after one second by default: a deadline a loaded machine overruns while
// the awaited work (a render, a subprocess, the engine) is still on its way. Every wait polls
// for ten seconds instead; the test timeout still bounds a condition that never comes true.
const WAIT_BUDGET_MS = 10_000;

const waitFor = vi.waitFor;
vi.waitFor = <T>(callback: () => T | Promise<T>, options?: Parameters<typeof waitFor>[1]) =>
  waitFor(
    callback,
    typeof options === 'number' ? options : { timeout: WAIT_BUDGET_MS, ...options },
  );
