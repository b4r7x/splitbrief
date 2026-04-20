import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadHookModule } from './load-module.js';
import type { EngineEvent } from '../events/types.js';
import type { HookContext } from './types.js';

const projectDir = resolve('.');
const ctx: HookContext = { projectDir, sessionId: 's' };
const allowEvent: EngineEvent = {
  type: 'task_started',
  ts: 1,
  phase: 'implementing',
  taskId: 'T1' as never,
  title: 'normal task',
  index: 0,
  total: 1,
  file: 'a.ts',
  action: 'create',
};
const forbiddenEvent: EngineEvent = {
  type: 'task_started',
  ts: 1,
  phase: 'implementing',
  taskId: 'T2' as never,
  title: 'forbidden task',
  index: 0,
  total: 1,
  file: 'a.ts',
  action: 'create',
};

describe('loadHookModule', () => {
  it('loads a valid module and returns the default function', async () => {
    const result = await loadHookModule('testing/fixtures/hooks/sample-module.mjs', projectDir);
    expect(result.ok).toBe(true);
  });

  it('invokes the loaded function — returns deny for forbidden title', async () => {
    const result = await loadHookModule('testing/fixtures/hooks/sample-module.mjs', projectDir);
    if (!result.ok) throw new Error(result.reason);
    const outcome = await result.fn(forbiddenEvent, ctx);
    expect(outcome.kind).toBe('deny');
    if (outcome.kind === 'deny') expect(outcome.message).toBe('forbidden by sample-module');
  });

  it('invokes the loaded function — returns allow for normal title', async () => {
    const result = await loadHookModule('testing/fixtures/hooks/sample-module.mjs', projectDir);
    if (!result.ok) throw new Error(result.reason);
    const outcome = await result.fn(allowEvent, ctx);
    expect(outcome.kind).toBe('allow');
  });

  it('returns ok:false on missing file', async () => {
    const result = await loadHookModule('./does-not-exist.mjs', projectDir);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when module has no default export', async () => {
    const result = await loadHookModule('testing/fixtures/hooks/no-default-export.mjs', projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not a function');
  });

  it('resolves relative paths against projectDir', async () => {
    const result = await loadHookModule('testing/fixtures/hooks/sample-module.mjs', projectDir);
    expect(result.ok).toBe(true);
  });
});
