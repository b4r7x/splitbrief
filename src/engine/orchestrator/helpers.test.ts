import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowState } from '../../types.js';
import { makeTask, makeUsage } from '#testing/helpers/fixtures.js';

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
}));

import { refreshCurrentCode, allValidationsPassed, addUsageAndSave, withSignalHandlers, isSignalError } from './helpers.js';

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
    completedTasks: [],
    escalatedTasks: [],
    skippedTasks: [],
    failedTasks: [],
    sessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    ...overrides,
  };
}

describe('refreshCurrentCode', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'helpers-refresh-'));
    mkdirSync(join(projectDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('populates task.currentCode with file contents when file exists', () => {
    writeFileSync(join(projectDir, 'src', 'hello.ts'), 'const x = 1;');

    const task = makeTask({ file: 'src/hello.ts' });
    refreshCurrentCode(task, projectDir);

    expect(task.currentCode).toBe('const x = 1;');
  });

  it('leaves currentCode undefined when file does not exist', () => {
    const task = makeTask({ file: 'src/missing.ts' });
    refreshCurrentCode(task, projectDir);

    expect(task.currentCode).toBeUndefined();
  });
});

describe('allValidationsPassed', () => {
  it('returns true when all pass, false when any fails', () => {
    expect(allValidationsPassed([])).toBe(true);
    expect(allValidationsPassed([{ stage: 'typecheck', passed: true }, { stage: 'lint', passed: true }])).toBe(true);
    expect(allValidationsPassed([{ stage: 'typecheck', passed: true }, { stage: 'lint', passed: false, error: 'err' }])).toBe(false);
  });
});

describe('addUsageAndSave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accumulates token usage and emits cost-update event', () => {
    const state = makeState({
      tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }),
    });
    const events: any[] = [];
    const callbacks = { onEvent: (e: any) => events.push(e) } as any;

    const result = addUsageAndSave('/tmp/proj', state, 'planner', {
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
    const events: any[] = [];
    const callbacks = { onEvent: (e: any) => events.push(e) } as any;
    const result = addUsageAndSave('/tmp/proj', state, 'implementer', null, callbacks);

    expect(result).toBe(state);
    expect(events).toHaveLength(0);
  });
});

describe('withSignalHandlers', () => {
  it('executes the function to completion and cleans up handlers', async () => {
    let executed = false;
    const removeSpy = vi.spyOn(process, 'removeListener');

    await withSignalHandlers(vi.fn(), async () => {
      executed = true;
    });

    expect(executed).toBe(true);
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

  it('calls handler and throws SignalError when signal received during fn', async () => {
    const handler = vi.fn();
    const onSpy = vi.spyOn(process, 'on');

    let capturedSigintHandler: (() => void) | undefined;
    onSpy.mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') capturedSigintHandler = listener as () => void;
      return process;
    }) as typeof process.on);

    const promise = withSignalHandlers(handler, async () => {
      capturedSigintHandler!();
    });

    await expect(promise).rejects.toSatisfy(isSignalError);
    await expect(promise).rejects.toThrow('SIGINT');
    expect(handler).toHaveBeenCalledOnce();

    onSpy.mockRestore();
  });

  it('does not throw SignalError when no signal received', async () => {
    const handler = vi.fn();
    await expect(
      withSignalHandlers(handler, async () => {}),
    ).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
