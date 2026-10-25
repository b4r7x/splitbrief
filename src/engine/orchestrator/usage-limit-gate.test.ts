import { describe, expect, it } from 'vitest';
import type { EngineEvent, EngineEventOf } from '../events/types.js';
import { createEventBus } from '../events/bus.js';
import { normalizeRunnerCallWarning } from '../calls/warnings.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { publishRunnerCallEvent } from './events.js';
import { seedUsageLimitSteps } from './usage-limit-gate.js';

function makeCallWarning(options: {
  step: number;
  window?: 'five_hour' | 'seven_day';
  resetsAt?: number;
  code?: string;
  callId?: string;
}): RunnerCallEvent {
  const {
    step,
    window = 'five_hour',
    resetsAt,
    code = 'claude_rate_limit',
    callId = 'call-1',
  } = options;
  return {
    type: 'call_warning',
    ts: 1_000,
    callId,
    role: 'planner',
    backendKind: 'cli',
    warning: normalizeRunnerCallWarning({
      code,
      message: `usage ${step}%`,
      usage: {
        window,
        step,
        ...(resetsAt !== undefined && { resetsAt }),
      },
    }),
  };
}

function makeRunnerWarning(options: {
  step: number;
  window?: 'five_hour' | 'seven_day';
  resetsAt?: number;
  code?: string;
  callId?: string;
  sequence?: number;
}): EngineEventOf<'runner_call_warning'> {
  const {
    step,
    window = 'five_hour',
    resetsAt,
    code = 'claude_rate_limit',
    callId = 'call-1',
    sequence = 0,
  } = options;
  return {
    type: 'runner_call_warning',
    ts: 1_000,
    phase: 'planning',
    callId,
    role: 'planner',
    backendKind: 'cli',
    sequence,
    warning: normalizeRunnerCallWarning({
      code,
      message: `usage ${step}%`,
      usage: {
        window,
        step,
        ...(resetsAt !== undefined && { resetsAt }),
      },
    }),
  };
}

function callWarnings(events: readonly EngineEvent[]): EngineEventOf<'runner_call_warning'>[] {
  return events.filter(
    (event): event is EngineEventOf<'runner_call_warning'> => event.type === 'runner_call_warning',
  );
}

function countOf(events: readonly EngineEvent[], type: EngineEvent['type']): number {
  return events.filter((event) => event.type === type).length;
}

describe('usage limit gate', () => {
  it('drops a warning below the shown step', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 75, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);
  });

  it('admits a jump and updates the shown step', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 85, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(2);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 80, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(2);
  });

  it('drops the same step twice', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);
  });

  it('re-arms steps on a rolled window with a new reset time', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 90, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 90, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 2_000_000 }));
    expect(callWarnings(published)).toHaveLength(2);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 2_000_000 }));
    expect(callWarnings(published)).toHaveLength(2);
  });

  it('tracks both windows apart', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(
      ctx,
      makeCallWarning({ window: 'five_hour', step: 75, resetsAt: 1_000_000 }),
    );
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(
      ctx,
      makeCallWarning({ window: 'seven_day', step: 70, resetsAt: 5_000_000 }),
    );
    expect(callWarnings(published)).toHaveLength(2);

    publishRunnerCallEvent(
      ctx,
      makeCallWarning({ window: 'five_hour', step: 70, resetsAt: 1_000_000 }),
    );
    expect(callWarnings(published)).toHaveLength(2);

    publishRunnerCallEvent(
      ctx,
      makeCallWarning({ window: 'seven_day', step: 75, resetsAt: 5_000_000 }),
    );
    expect(callWarnings(published)).toHaveLength(3);
  });

  it('suppresses steps at or below the highest step recorded on a seeded bus', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    seedUsageLimitSteps(bus, [
      makeRunnerWarning({ step: 70, resetsAt: 1_000_000 }),
      makeRunnerWarning({ step: 80, resetsAt: 1_000_000 }),
      makeRunnerWarning({ step: 75, resetsAt: 1_000_000 }),
    ]);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(0);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 80, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(0);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 85, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);
  });

  it('does not increment sequence number when a warning is dropped', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);
    const seqFirst = callWarnings(published)[0]?.sequence;

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 70, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(1);

    publishRunnerCallEvent(ctx, makeCallWarning({ step: 75, resetsAt: 1_000_000 }));
    expect(callWarnings(published)).toHaveLength(2);
    const seqSecond = callWarnings(published)[1]?.sequence;

    expect(seqFirst).toBeDefined();
    expect(seqSecond).toBe((seqFirst ?? 0) + 1);
  });

  it('admits non-usage call events and call warnings without usage', () => {
    const bus = createEventBus();
    const published: EngineEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const ctx = { bus, phase: 'planning' as const, rootDir: '/test' };

    publishRunnerCallEvent(ctx, {
      type: 'call_started',
      ts: 1_000,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
    });
    expect(countOf(published, 'runner_call_started')).toBe(1);

    publishRunnerCallEvent(ctx, {
      type: 'call_warning',
      ts: 1_001,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      warning: normalizeRunnerCallWarning({
        code: 'general_warning',
        message: 'Something happened',
      }),
    });
    expect(countOf(published, 'runner_call_warning')).toBe(1);
  });
});
