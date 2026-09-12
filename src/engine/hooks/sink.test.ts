import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createHookSink } from './sink.js';
import type { HookCommandEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import { createEventBus } from '../events/bus.js';
import { taskId } from '../../core/schemas/task.js';
import { markHooksConfigTrusted } from '../../core/hooks/trust.js';
import { makeAllowHook, makeCommandHookEntry } from '#testing/helpers/factories/hook-entry.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';

let projectDir: string;
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('splitbrief-hook-sink-home');
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-hook-sink-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  trustHome.restore();
});

function ctx() {
  return { projectDir, sessionId: 'sess-1' };
}

function trust(hooks: HooksConfig): HooksConfig {
  markHooksConfigTrusted(projectDir, hooks);
  return hooks;
}

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
  taskId: taskId('T001'),
  title: 'my task',
  method: 'local',
  retries: 0,
  duration: 100,
};

describe('createHookSink', () => {
  it('does nothing when no hooks are configured for the event', async () => {
    const { bus, warnings, all } = makeBus();
    const hooks: HooksConfig = {};
    const sink = createHookSink(hooks, ctx(), bus);
    sink(taskCompletedEvent);
    await waitForNoActivity(all);
    expect(warnings).toHaveLength(0);
    expect(all).toHaveLength(0);
  });

  it('stays silent when a post_task hook succeeds', async () => {
    const { bus, warnings, all } = makeBus();
    const hooks = trust({ post_task: [makeAllowHook('allow-hook')] });
    const sink = createHookSink(hooks, ctx(), bus);
    sink(taskCompletedEvent);
    await waitForNoActivity(all);
    expect(warnings).toHaveLength(0);
  });

  it('publishes a warning when a post_task command hook fails', async () => {
    const { bus, warnings } = makeBus();
    const hooks = trust({
      post_task: [makeCommandHookEntry({ command: 'false', name: 'fails', on_failure: 'warn' })],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('fails');
  });

  it('runs multiple hooks sequentially in order', async () => {
    const { bus, warnings } = makeBus();
    const hooks = trust({
      post_task: [
        makeCommandHookEntry({ command: 'false', name: 'hook-a', on_failure: 'warn' }),
        makeCommandHookEntry({ command: 'false', name: 'hook-b', on_failure: 'warn' }),
      ],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('hook-a');
    expect(warnings[1]).toContain('hook-b');
  });

  it('logs deny from post_* hook as informational warning, does not block', async () => {
    const { bus, warnings } = makeBus();
    const hooks = trust({
      post_task: [denyViaStdoutHook('deny-cmd', 'not allowed')],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('informational only');
  });

  it('does not dispatch for validate events with status=running (only done)', async () => {
    const { bus, warnings, all } = makeBus();
    const hooks = trust({
      post_validation: [
        makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' }),
      ],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    const runningEvent: EngineEvent = {
      type: 'validate',
      ts: 1,
      phase: 'implementing',
      taskId: taskId('T001'),
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
    const hooks = trust({
      post_validation: [
        makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' }),
      ],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    const doneEvent: EngineEvent = {
      type: 'validate',
      ts: 1,
      phase: 'implementing',
      taskId: taskId('T001'),
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
    const hooks = trust({
      on_complete: [makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' })],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    const completeEvent: EngineEvent = { type: 'workflow_complete', ts: 1, phase: 'idle' };
    sink(completeEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marker');
  });

  it('dispatches on_error for error event', async () => {
    const { bus, warnings } = makeBus();
    const hooks = trust({
      on_error: [makeCommandHookEntry({ command: 'false', name: 'marker', on_failure: 'warn' })],
    });
    const sink = createHookSink(hooks, ctx(), bus);
    const errorEvent: EngineEvent = { type: 'error', ts: 1, phase: 'idle', message: 'err' };
    sink(errorEvent);
    await waitForWarnings(warnings, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marker');
  });

  it('refuses a trusted post hook script after its bytes change', async () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(
      join(projectDir, 'hooks', 'post.mjs'),
      'process.stdout.write(JSON.stringify({ decision: "allow" }));\n',
    );
    const marker = join(projectDir, 'marker.txt');
    const hooks = trust({
      post_task: [makeCommandHookEntry({ command: 'node', args: ['hooks/post.mjs'] })],
    });
    writeFileSync(
      join(projectDir, 'hooks', 'post.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );
    const { bus, warnings } = makeBus();
    const sink = createHookSink(hooks, ctx(), bus);

    sink(taskCompletedEvent);
    await waitForWarnings(warnings, 1);

    expect(warnings[0]).toContain('changed after trust');
    expect(existsSync(marker)).toBe(false);
  });
});
