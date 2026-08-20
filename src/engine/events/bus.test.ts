import { describe, it, expect } from 'vitest';
import { createEventBus } from './bus.js';
import { parseEngineEvent } from './schema.js';
import type { EngineEvent } from './types.js';

function ev(overrides: { feature?: string } = {}): EngineEvent {
  const event = parseEngineEvent({
    type: 'workflow_started',
    ts: 1,
    phase: 'idle',
    feature: 'x',
    ...overrides,
  });
  if (event === null) throw new Error('expected a valid engine event fixture');
  return event;
}

describe('eventBus', () => {
  it('delivers a published event to a subscribed sink', () => {
    const bus = createEventBus();
    const seen: EngineEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.publish(ev());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('workflow_started');
  });

  it('delivers events to sinks in subscription order', () => {
    const bus = createEventBus();
    const order: number[] = [];
    bus.subscribe(() => order.push(1));
    bus.subscribe(() => order.push(2));
    bus.subscribe(() => order.push(3));
    bus.publish(ev());
    expect(order).toEqual([1, 2, 3]);
  });

  it('unsubscribe stops further deliveries to that sink only', () => {
    const bus = createEventBus();
    const a: EngineEvent[] = [];
    const b: EngineEvent[] = [];
    const unsubA = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.publish(ev());
    unsubA();
    bus.publish(ev({ feature: 'y' }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('a throwing sink does not block other sinks', () => {
    const bus = createEventBus();
    const seen: EngineEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => seen.push(e));
    expect(() => bus.publish(ev())).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('subscribing the same sink twice is idempotent (Set semantics)', () => {
    const bus = createEventBus();
    const seen: EngineEvent[] = [];
    const sink = (e: EngineEvent) => seen.push(e);
    bus.subscribe(sink);
    bus.subscribe(sink);
    bus.publish(ev());
    expect(seen).toHaveLength(1);
  });
});
