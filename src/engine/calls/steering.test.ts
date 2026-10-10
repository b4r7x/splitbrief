import { describe, expect, it, vi } from 'vitest';
import { createSteeringPort, deliverToRunningCall, type RunningCall } from './steering.js';

function call(callId: string): RunningCall {
  return {
    callId,
    role: 'implementer',
    taskId: 'T001',
    send: vi.fn().mockResolvedValue('delivered'),
  };
}

describe('steering port', () => {
  it('defers when there is no call', async () => {
    await expect(deliverToRunningCall(null, { id: 'm', text: 'hello' })).resolves.toBe('deferred');
  });

  it('publishes attach and detach and delegates to the captured call', async () => {
    const onChange = vi.fn();
    const port = createSteeringPort({ onChange });
    expect(port.current()).toBeNull();
    const first = call('first');
    const detach = port.attach(first);
    const captured = port.current();
    expect(captured).toBe(first);
    detach();
    expect(port.current()).toBeNull();
    const message = { id: 'm', text: 'hello' };
    await expect(deliverToRunningCall(captured, message)).resolves.toBe('delivered');
    expect(first.send).toHaveBeenCalledWith(message);
    expect(onChange.mock.calls).toEqual([[first], [null]]);
  });

  it('never lets an older detach clear a newer attachment, even of the same handle', () => {
    const onChange = vi.fn();
    const port = createSteeringPort({ onChange });
    const first = call('first');
    const oldDetach = port.attach(first);
    const newDetach = port.attach(first);
    oldDetach();
    expect(port.current()).toBe(first);
    newDetach();
    newDetach();
    expect(port.current()).toBeNull();
    expect(onChange.mock.calls).toEqual([[first], [first], [null]]);
  });
});
