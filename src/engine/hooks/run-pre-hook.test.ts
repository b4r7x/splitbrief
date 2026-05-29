import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runPreHooks } from './run-pre-hook.js';
import type { HookCommandEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import {
  makeCommandHookEntry,
  makeAllowHook,
  makeThrowingModuleHook,
} from '#testing/helpers/factories/hook-entry.js';

const projectDir = resolve('.');
const ctx = { projectDir, sessionId: 'sess-1' };

const preTaskEvent: EngineEvent = {
  type: 'task_started',
  ts: 1,
  phase: 'implementing',
  taskId: 'T1' as never,
  title: 'my task',
  index: 0,
  total: 1,
  file: 'src/foo.ts',
  action: 'create',
};

function denyViaStdout(message?: string): HookCommandEntry {
  const payload = message === undefined ? { decision: 'deny' } : { decision: 'deny', message };
  return makeCommandHookEntry({
    command: 'node',
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
    on_failure: 'block',
  });
}

function nonZeroExitHook(): HookCommandEntry {
  return makeCommandHookEntry({ command: 'false', on_failure: 'block' });
}

describe('runPreHooks', () => {
  it('returns allow when hooks config is undefined', async () => {
    const result = await runPreHooks(undefined, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(true);
  });

  it('returns allow when no entries for the event', async () => {
    const hooks: HooksConfig = {};
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(true);
  });

  it('returns allow when a single allow hook passes', async () => {
    const hooks: HooksConfig = { pre_task: [makeAllowHook()] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(true);
  });

  it('returns not-allow with reason when deny+block', async () => {
    const hooks: HooksConfig = { pre_task: [denyViaStdout('access denied')] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('access denied');
  });

  it('returns not-allow when a module pre-hook returns deny', async () => {
    const hooks: HooksConfig = {
      pre_task: [
        {
          kind: 'module',
          path: 'testing/fixtures/hooks/sample-module.mjs',
          timeout_ms: 5000,
          on_failure: 'warn',
        },
      ],
    };
    const result = await runPreHooks(
      hooks,
      'pre_task',
      { ...preTaskEvent, title: 'forbidden task' },
      ctx,
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('forbidden by sample-module');
  });

  it('uses default reason message when deny has no message', async () => {
    const hooks: HooksConfig = { pre_task: [denyViaStdout()] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('pre_task hook denied');
  });

  it('honors deny outcome regardless of on_failure=warn', async () => {
    const entry = denyViaStdout('just a warn');
    entry.on_failure = 'warn';
    const hooks: HooksConfig = { pre_task: [entry] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('just a warn');
  });

  it('honors deny outcome regardless of on_failure=ignore', async () => {
    const entry = denyViaStdout('ignored');
    entry.on_failure = 'ignore';
    const hooks: HooksConfig = { pre_task: [entry] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('ignored');
  });

  it('returns not-allow when crash+block', async () => {
    const hooks: HooksConfig = { pre_task: [makeThrowingModuleHook({ on_failure: 'block' })] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('segfault');
  });

  it('returns allow when crash+warn (not block)', async () => {
    const hooks: HooksConfig = {
      pre_task: [makeThrowingModuleHook({ on_failure: 'warn' })],
    };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(true);
  });

  it('short-circuits after first deny+block — skips remaining hooks', async () => {
    const hooks: HooksConfig = {
      pre_task: [
        denyViaStdout('first denied'),
        // A second hook whose failure mode differs would change the reason if it ran;
        // short-circuit is observable by the reason coming from the first hook.
        nonZeroExitHook(),
      ],
    };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('first denied');
  });

  it('runs multiple hooks sequentially and allows if all pass', async () => {
    const hooks: HooksConfig = { pre_task: [makeAllowHook(), makeAllowHook()] };
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx);
    expect(result.allow).toBe(true);
  });
});
