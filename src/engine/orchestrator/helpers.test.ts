import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState, OrchestratorCallbacks, TuiEvent } from '../../types.js';
import { makeTask, makeUsage } from '#testing/helpers/fixtures.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
}));

import { refreshCurrentCode, allValidationsPassed, addUsageAndSave, withSignalHandlers } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'test',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    sessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    ...overrides,
  };
}

describe('refreshCurrentCode', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('helpers-refresh');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('returns a new task with currentCode populated from file contents when file exists', async () => {
    writeFileSync(join(projectDir, 'src', 'hello.ts'), 'const x = 1;');

    const task = makeTask({ file: 'src/hello.ts' });
    const refreshed = await refreshCurrentCode(task, projectDir);

    expect(refreshed.currentCode).toBe('const x = 1;');
    expect(task.currentCode).toBeUndefined();
  });

  it('returns the original task unchanged when file does not exist', async () => {
    const task = makeTask({ file: 'src/missing.ts' });
    const refreshed = await refreshCurrentCode(task, projectDir);

    expect(refreshed).toBe(task);
    expect(refreshed.currentCode).toBeUndefined();
  });
});

describe('allValidationsPassed', () => {
  it('returns true when all pass, false when any fails', () => {
    expect(allValidationsPassed([])).toBe(true);
    expect(allValidationsPassed([{ stage: 'tsc', passed: true }, { stage: 'lint', passed: true }])).toBe(true);
    expect(allValidationsPassed([{ stage: 'tsc', passed: true }, { stage: 'lint', passed: false, error: 'err' }])).toBe(false);
  });
});

describe('addUsageAndSave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accumulates token usage and emits cost-update event', () => {
    const state = makeState({
      tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }),
    });
    const events: TuiEvent[] = [];
    const callbacks = { onEvent: (e: TuiEvent) => events.push(e) } as Partial<OrchestratorCallbacks> as OrchestratorCallbacks;

    const result = addUsageAndSave('/tmp/proj', 'test-session', state, 'planner', {
      inputTokens: 200,
      outputTokens: 100,
    }, callbacks);

    expect(result.tokenUsage.plannerInput).toBe(300);
    expect(result.tokenUsage.plannerOutput).toBe(150);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cost-update' });
  });

  it('returns unchanged state and emits no event when usage is null', () => {
    const state = makeState();
    const events: TuiEvent[] = [];
    const callbacks = { onEvent: (e: TuiEvent) => events.push(e) } as Partial<OrchestratorCallbacks> as OrchestratorCallbacks;
    const result = addUsageAndSave('/tmp/proj', 'test-session', state, 'implementer', null, callbacks);

    expect(result).toBe(state);
    expect(events).toHaveLength(0);
  });
});

describe('withSignalHandlers', () => {
  it('executes the function to completion and cleans up handlers', async () => {
    let executed = false;
    const removeSpy = vi.spyOn(process, 'removeListener');

    const result = await withSignalHandlers(vi.fn(), async () => {
      executed = true;
    });

    expect(executed).toBe(true);
    expect(result).toEqual({ cancelled: false });
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('removes signal handlers even if fn throws', async () => {
    const handler = vi.fn();
    const removeSpy = vi.spyOn(process, 'removeListener');

    await expect(
      withSignalHandlers(handler, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    removeSpy.mockRestore();
  });

  it('returns cancelled=true and calls handler when signal received during fn', async () => {
    const handler = vi.fn();
    const onSpy = vi.spyOn(process, 'on');

    let capturedSigintHandler: (() => void) | undefined;
    onSpy.mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') capturedSigintHandler = listener as () => void;
      return process;
    }) as typeof process.on);

    const result = await withSignalHandlers(handler, async () => {
      capturedSigintHandler!();
    });

    expect(result).toEqual({ cancelled: true });
    expect(handler).toHaveBeenCalledOnce();

    onSpy.mockRestore();
  });

  it('returns cancelled=false when no signal received', async () => {
    const handler = vi.fn();
    const result = await withSignalHandlers(handler, async () => {});
    expect(result).toEqual({ cancelled: false });
    expect(handler).not.toHaveBeenCalled();
  });
});
