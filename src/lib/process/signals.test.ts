import { describe, it, expect, vi } from 'vitest';
import {
  holdTerminationSignals,
  onUnheldTerminationSignal,
  releaseTerminationSignals,
  withSignalHandlers,
} from './signals.js';

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

  it('propagates exceptions and still removes every signal listener it installed', async () => {
    const handler = vi.fn();
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
    };

    await expect(
      withSignalHandlers(handler, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect({
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
    }).toEqual(before);
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

  it('passes the handler the signal that arrived and returns the value fn produced', async () => {
    const handler = vi.fn();

    const result = await withSignalHandlers(handler, async () => {
      process.emit('SIGTERM', 'SIGTERM');
      return 'applied';
    });

    expect(result).toEqual({ cancelled: true, value: 'applied' });
    expect(handler).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns cancelled=true and fires handler on SIGHUP (terminal close / SSH drop)', async () => {
    const handler = vi.fn();

    const result = await withSignalHandlers(handler, async () => {
      process.emit('SIGHUP');
    });

    expect(result).toEqual({ cancelled: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});

// The listeners stay on the process of this test file, so this case runs last.
describe('onUnheldTerminationSignal', () => {
  it('leaves each signal to a holder and calls the stop for a signal that no holder takes', async () => {
    const stop = vi.fn();
    const held = vi.fn();
    onUnheldTerminationSignal(stop);

    await withSignalHandlers(held, async () => {
      process.emit('SIGTERM', 'SIGTERM');
    });
    holdTerminationSignals(held);
    process.emit('SIGINT', 'SIGINT');
    releaseTerminationSignals(held);
    expect(held.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
    expect(stop).not.toHaveBeenCalled();

    process.emit('SIGHUP', 'SIGHUP');
    expect(stop).toHaveBeenCalledExactlyOnceWith('SIGHUP');
  });
});
