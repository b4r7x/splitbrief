import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createHookSink } from './sink.js';
import type { HookCommandEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import { createEventBus } from '../events/bus.js';
import {
  makeCommandHookEntry,
  makeAllowHook,
  makeThrowingModuleHook,
} from '#testing/helpers/factories/hook-entry.js';

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

function denyViaStdoutHook(name: string, message: string): HookCommandEntry {
  const payload = JSON.stringify({ decision: 'deny', message });
  return makeCommandHookEntry({
    command: 'node',
    args: ['-e', `process.stdout.write(${JSON.stringify(payload)})`],
    name,
    on_failure: 'block',
  });
}

async function waitForWarnings(
  warnings: readonly string[],
  expected: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (warnings.length < expected) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 50));
}

async function waitForNoActivity(all: readonly unknown[], idleMs = 400): Promise<void> {
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
    {
      const { bus, warnings, all } = makeBus();
      const hooks: HooksConfig = { post_task: [makeAllowHook('allow-hook')] };
      const sink = createHookSink(hooks, ctx, bus);
      sink(taskCompletedEvent);
      await waitForNoActivity(all);
      expect(warnings).toHaveLength(0);
    }
    {
      const { bus, warnings } = makeBus();
      const hooks: HooksConfig = {
        post_task: [makeCommandHookEntry({ command: 'false', name: 'fails', on_failure: 'warn' })],
      };
      const sink = createHookSink(hooks, ctx, bus);
      sink(taskCompletedEvent);
      await waitForWarnings(warnings, 1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('fails');
    }
  });

  it('runs multiple hooks sequentially in order', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      post_task: [
        makeCommandHookEntry({ command: 'false', name: 'hook-a', on_failure: 'warn' }),
        makeCommandHookEntry({ command: 'false', name: 'hook-b', on_failure: 'warn' }),
      ],
    };
    const sink = createHookSink(hooks, ctx, bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('hook-a');
    expect(warnings[1]).toContain('hook-b');
  });

  it('publishes a warning when a hook crashes, but does not gate the flow', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = { post_task: [makeThrowingModuleHook({ name: 'crash-hook' })] };
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
      post_validation: [
        makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' }),
      ],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const runningEvent: EngineEvent = {
      type: 'validate',
      ts: 1,
      phase: 'implementing',
      taskId: 'T1' as never,
      status: 'running',
      passed: false,
      stages: { typecheck: false, lint: false, test: false },
    };
    sink(runningEvent);
    await waitForNoActivity(all);
    expect(warnings).toHaveLength(0);
    expect(all).toHaveLength(0);
  });

  it('dispatches post_validation for validate event with status=done', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      post_validation: [
        makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' }),
      ],
    };
    const sink = createHookSink(hooks, ctx, bus);
    const doneEvent: EngineEvent = {
      type: 'validate',
      ts: 1,
      phase: 'implementing',
      taskId: 'T1' as never,
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    };
    sink(doneEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marker');
  });

  it('dispatches on_complete for workflow_complete event', async () => {
    const { bus, warnings } = makeBus();
    const hooks: HooksConfig = {
      on_complete: [makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' })],
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
      on_error: [makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' })],
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
    const hooks: HooksConfig = {
      post_task: [makeThrowingModuleHook({ name: 'unexpected-throw' })],
    };
    const sink = createHookSink(hooks, ctx, bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('segfault');
  });
});
