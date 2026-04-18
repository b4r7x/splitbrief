import { describe, it, expect, vi } from 'vitest';
import { withSignalHandlers } from './signals.js';

describe('withSignalHandlers', () => {
  it('executes the function to completion and returns cancelled=false when no signal fires', async () => {
    let executed = false;
    const handler = vi.fn();

    const result = await withSignalHandlers(handler, async () => {
      executed = true;
    });

    expect(executed).toBe(true);
    expect(result).toEqual({ cancelled: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates exceptions and still cleans up — future invocations run without inherited handlers', async () => {
    const handler = vi.fn();

    await expect(
      withSignalHandlers(handler, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    const after = await withSignalHandlers(handler, async () => {});
    expect(after).toEqual({ cancelled: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns cancelled=true and fires handler when a real SIGINT arrives during fn', async () => {
    const handler = vi.fn();

    const result = await withSignalHandlers(handler, async () => {
      // Raise a real SIGINT from within the wrapped function. Node's EventEmitter
      // is synchronous for `emit`, so the registered handler runs before emit returns.
      process.emit('SIGINT');
    });

    expect(result).toEqual({ cancelled: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns cancelled=true on SIGTERM as well', async () => {
    const handler = vi.fn();

    const result = await withSignalHandlers(handler, async () => {
      process.emit('SIGTERM');
    });

    expect(result).toEqual({ cancelled: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});
