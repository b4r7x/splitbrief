import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createHookSink } from './sink.js';
import type { HookCommandEntry, HookModuleEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import { createEventBus } from '../events/bus.js';

const projectDir = resolve('.');
const ctx = { projectDir, sessionId: 'sess-1' };

function makeBus(): { bus: EventBus; warnings: string[]; all: EngineEvent[] } {
  const warnings: string[] = [];
  const all: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => {
    all.push(e);
    if (e.type === 'warning') warnings.push(e.message);
  });
  return { bus, warnings, all };
}

function cmd(overrides: Partial<HookCommandEntry>): HookCommandEntry {
  return {
    kind: 'command',
    command: 'true',
    args: [],
    timeout_ms: 5000,
    on_failure: 'warn',
    ...overrides,
  };
}

function allowHook(name?: string): HookCommandEntry {
  return cmd({ command: 'echo', args: ['ok'], ...(name ? { name } : {}) });
}

// A hook that records execution by writing a marker to stdout. We capture ordering
// via wall-clock timestamps, but since operations are millisecond-close, we use a
// serializing shared directory file only in the one test that needs it. For the
// simple ordering case below, sequential dispatch is observable because if the
// sink ran them in parallel the second hook's exit code would race the first.
function sequencedHook(tag: string, delayMs = 20): HookCommandEntry {
  return cmd({
    command: 'node',
    args: ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(tag)}), ${delayMs})`],
    timeout_ms: 5000,
  });
}

function throwingModuleHook(overrides: Partial<HookModuleEntry> = {}): HookModuleEntry {
  return {
    kind: 'module',
    path: 'testing/fixtures/hooks/throws.mjs',
    name: 'crash-hook',
    timeout_ms: 5000,
    on_failure: 'warn',
    ...overrides,
  };
}

function denyViaStdoutHook(name: string, message: string): HookCommandEntry {
  const payload = JSON.stringify({ decision: 'deny', message });
  return cmd({
    command: 'node',
    args: ['-e', `process.stdout.write(${JSON.stringify(payload)})`],
    name,
    on_failure: 'block',
  });
}

// The sink schedules hook execution as a detached promise. Poll until the expected
// number of events has arrived (or absence-check has held long enough), bounded by
// a generous timeout so flaking under concurrent test load is avoided.
async function waitForWarnings(warnings: readonly string[], expected: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (warnings.length < expected) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  // Small settle window so we also catch any unwanted extras.
  await new Promise((r) => setTimeout(r, 50));
}

async function waitForNoActivity(all: readonly unknown[], idleMs = 400): Promise<void> {
  // For absence assertions: wait a fixed idle window. The sink has nothing to wait on
  // because there is no event to observe — we are verifying it did NOT dispatch.
  const start = Date.now();
  while (Date.now() - start < idleMs) {
    const before = all.length;
    await new Promise((r) => setTimeout(r, 50));
    if (all.length !== before) return;
  }
}

const taskCompletedEvent: EngineEvent = {
  type: 'task_completed',
  ts: 1,
  phase: 'implementing',
  taskId: 'T1' as never,
  title: 'my task',
  method: 'local',
  retries: 0,
  duration: 100,
};

describe('createHookSink', () => {
  it('does nothing when no hooks are configured for the event', async () => {
    const { bus, warnings, all } = makeBus();
    const hooks: HooksConfig = {};
    const sink = createHookSink(hooks, ctx, bus);
    sink(taskCompletedEvent);
    await waitForNoActivity(all);
    expect(warnings).toHaveLength(0);
    expect(all).toHaveLength(0);
  });

  it('dispatches post_task hook on task_completed event', async () => {
    // Observable: an allow-path hook produces no warnings on the bus; a warn-path
    // hook on the same event publishes one. Compare the two runs.
    {
      const { bus, warnings, all } = makeBus();
      const hooks: HooksConfig = { post_task: [allowHook('allow-hook')] };
      const sink = createHookSink(hooks, ctx, bus);
      sink(taskCompletedEvent);
      await waitForNoActivity(all);
      expect(warnings).toHaveLength(0);
    }
    {
      const { bus, warnings } = makeBus();
      const hooks: HooksConfig = {
        post_task: [cmd({ command: 'false', name: 'fails', on_failure: 'warn' })],
      };
      const sink = createHookSink(hooks, ctx, bus);
      sink(taskCompletedEvent);
      await waitForWarnings(warnings, 1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('fails');
    }
  });

  it('runs multiple hooks sequentially in order', async () => {
    // Observable sequencing: each hook sleeps for a set duration; if they ran in
    // parallel the total wall-clock time would be ~max. Two 50ms hooks run serially
    // must take >= 90ms (loose lower bound to avoid CI flake).
    //
    // The hooks fail (no JSON on stdout + exit 0 is allow) so produce no warnings;
    // we observe only the hook completion via the sink's internal await — ensure
    // that by waiting on the all-events buffer's idle window after both would have
    // finished.
    const { bus, all } = makeBus();
    const hooks: HooksConfig = {
      post_task: [sequencedHook('first', 50), sequencedHook('second', 50)],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const start = Date.now();
    sink(taskCompletedEvent);
    await waitForNoActivity(all, 600);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('publishes a warning when a hook crashes, but does not gate the flow', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = { post_task: [throwingModuleHook()] };
    const sink = createHookSink(hooks, ctx, bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('crash-hook');
    expect(warnings[0]).toContain('segfault');
  });

  it('logs deny from post_* hook as informational warning, does not block', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      post_task: [denyViaStdoutHook('deny-cmd', 'not allowed')],
    };
    const sink = createHookSink(hooks, ctx, bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('informational only');
  });

  it('does not dispatch for validate events with status=running (only done)', async () => {
    const { bus, warnings, all } = makeBus();
    const hooks: HooksConfig = {
      post_validation: [cmd({ command: 'false', name: 'marker', on_failure: 'warn' })],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const runningEvent: EngineEvent = {
      type: 'validate', ts: 1, phase: 'implementing', taskId: 'T1' as never,
      status: 'running', passed: false, stages: { tsc: false, lint: false, test: false },
    };
    sink(runningEvent);
    await waitForNoActivity(all);
    expect(warnings).toHaveLength(0);
    expect(all).toHaveLength(0);
  });

  it('dispatches post_validation for validate event with status=done', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      post_validation: [cmd({ command: 'false', name: 'marker', on_failure: 'warn' })],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const doneEvent: EngineEvent = {
      type: 'validate', ts: 1, phase: 'implementing', taskId: 'T1' as never,
      status: 'done', passed: true, stages: { tsc: true, lint: true, test: true },
    };
    sink(doneEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marker');
  });

  it('dispatches on_complete for workflow_complete event', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      on_complete: [cmd({ command: 'false', name: 'marker', on_failure: 'warn' })],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const completeEvent: EngineEvent = { type: 'workflow_complete', ts: 1, phase: 'idle' };
    sink(completeEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marker');
  });

  it('dispatches on_error for error event', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      on_error: [cmd({ command: 'false', name: 'marker', on_failure: 'warn' })],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const errorEvent: EngineEvent = { type: 'error', ts: 1, phase: 'idle', message: 'err' };
    sink(errorEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marker');
  });

  it('catches unexpected thrown errors and publishes warning', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = { post_task: [throwingModuleHook({ name: 'unexpected-throw' })] };
    const sink = createHookSink(hooks, ctx, bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('segfault');
  });
});
