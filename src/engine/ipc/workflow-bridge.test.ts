import { describe, expect, it } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';
import type { Phase } from '../../core/schemas/enums.js';

describe('createIpcWorkflowBridge', () => {
  it('forwards IPC user input into the installed workflow queue handler with the latest phase', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const calls: Array<[string, Phase]> = [];
    const queue = (text: string, phase: Phase) => {
      calls.push([text, phase]);
    };

    bridge.sinks.setQueueHandler(queue);
    bus.publish({ type: 'planner_status', ts: Date.now(), phase: 'planning', status: 'running' });

    bridge.onUserInput('  refine the plan  ');

    expect(calls[0]).toEqual(['refine the plan', 'planning']);
    bridge.close();
  });

  it('updates the forwarded phase as workflow events arrive', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const calls: Array<[string, Phase]> = [];
    const queue = (text: string, phase: Phase) => {
      calls.push([text, phase]);
    };

    bridge.sinks.setQueueHandler(queue);
    bus.publish({
      type: 'warning',
      ts: Date.now(),
      phase: 'implementing',
      message: 'phase update',
    });

    bridge.onUserInput('follow-up');

    expect(calls[0]).toEqual(['follow-up', 'implementing']);
    bridge.close();
  });

  it('publishes a warning instead of dropping input silently before the queue is ready', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const events: Array<{ type: string; phase?: Phase; message?: string }> = [];
    bus.subscribe((event) => events.push(event));

    bridge.onUserInput('hello');

    expect(events).toEqual([
      expect.objectContaining({
        type: 'warning',
        phase: 'idle',
        message: expect.stringContaining('queue not ready'),
      }),
    ]);
    bridge.close();
  });

  it('truncates long buffered input in the warning with a single ellipsis glyph', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const events: Array<{ type: string; message?: string }> = [];
    bus.subscribe((event) => events.push(event));

    const longInput = 'x'.repeat(80);
    bridge.onUserInput(longInput);

    const warning = events.find((event) => event.type === 'warning');
    expect(warning?.message).toBe(
      `IPC input buffered (queue not ready): ${longInput.slice(0, 39)}…`,
    );
    bridge.close();
  });

  it('exposes an AbortSignal that is not aborted initially', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);

    expect(bridge.signal.aborted).toBe(false);
    bridge.close();
  });

  it('abort() sets the signal to aborted', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);

    bridge.abort();

    expect(bridge.signal.aborted).toBe(true);
    bridge.close();
  });

  it('abort() invokes the registered abort handler', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    let handlerCalled = false;
    bridge.sinks.setAbortHandler(() => {
      handlerCalled = true;
    });

    bridge.abort();

    expect(handlerCalled).toBe(true);
    bridge.close();
  });

  it('abort() clears the handler after calling it once', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    let callCount = 0;
    bridge.sinks.setAbortHandler(() => {
      callCount++;
    });

    bridge.abort();
    bridge.abort();

    expect(callCount).toBe(1);
    bridge.close();
  });

  it('stores abort handler registered via setAbortHandler', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    let handlerCalled = false;
    bridge.sinks.setAbortHandler(() => {
      handlerCalled = true;
    });
    bridge.sinks.setAbortHandler(null);

    bridge.abort();

    expect(handlerCalled).toBe(false);
    bridge.close();
  });
});
