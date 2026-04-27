import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';
import type { Phase } from '../../core/schemas/enums.js';

describe('createIpcWorkflowBridge', () => {
  it('forwards IPC user input into the installed workflow queue handler with the latest phase', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const queue = vi.fn();

    bridge.sinks.setQueueHandler(queue);
    bus.publish({ type: 'planner_status', ts: Date.now(), phase: 'planning', status: 'running' });

    bridge.onUserInput('  refine the plan  ');

    expect(queue).toHaveBeenCalledWith('refine the plan', 'planning');
    bridge.close();
  });

  it('updates the forwarded phase as workflow events arrive', () => {
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const queue = vi.fn();

    bridge.sinks.setQueueHandler(queue);
    bus.publish({ type: 'warning', ts: Date.now(), phase: 'implementing', message: 'phase update' });

    bridge.onUserInput('follow-up');

    expect(queue).toHaveBeenCalledWith('follow-up', 'implementing');
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
        message: expect.stringContaining('queue was ready'),
      }),
    ]);
    bridge.close();
  });
});
