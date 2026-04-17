import { describe, it, expect, vi } from 'vitest';
import { withSignalHandlers } from './signals.js';

describe('withSignalHandlers', () => {
  it('executes the function to completion and cleans up handlers', async () => {
    let executed = false;
    const removeSpy = vi.spyOn(process, 'removeListener');

    const result = await withSignalHandlers(vi.fn(), async () => {
      executed = true;
    });

    expect(executed).toBe(true);
    expect(result).toEqual({ cancelled: false });
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('removes signal handlers even if fn throws', async () => {
    const handler = vi.fn();
    const removeSpy = vi.spyOn(process, 'removeListener');

    await expect(
      withSignalHandlers(handler, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    removeSpy.mockRestore();
  });

  it('returns cancelled=true and calls handler when signal received during fn', async () => {
    const handler = vi.fn();
    const onSpy = vi.spyOn(process, 'on');

    let capturedSigintHandler: (() => void) | undefined;
    onSpy.mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') capturedSigintHandler = listener as () => void;
      return process;
    }) as typeof process.on);

    const result = await withSignalHandlers(handler, async () => {
      capturedSigintHandler!();
    });

    expect(result).toEqual({ cancelled: true });
    expect(handler).toHaveBeenCalledOnce();

    onSpy.mockRestore();
  });

  it('returns cancelled=false when no signal received', async () => {
    const handler = vi.fn();
    const result = await withSignalHandlers(handler, async () => {});
    expect(result).toEqual({ cancelled: false });
    expect(handler).not.toHaveBeenCalled();
  });
});
