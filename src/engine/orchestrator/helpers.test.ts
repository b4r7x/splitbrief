import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, Task } from '../../types.js';
import { makeTask, makeUsage } from '#testing/helpers/fixtures.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../../state-persistence.js', () => ({
  saveState: vi.fn(),
}));

import { readFileSync, existsSync } from 'node:fs';
import { saveState } from '../../state-persistence.js';
import { refreshCurrentCode, allValidationsPassed, addUsageAndSave, withSignalHandlers } from './helpers.js';

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
  beforeEach(() => vi.clearAllMocks());

  it('reads file content into task.currentCode when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('const x = 1;');

    const task = makeTask({ file: 'src/hello.ts' });
    refreshCurrentCode(task, '/tmp/proj');

    expect(existsSync).toHaveBeenCalledWith('/tmp/proj/src/hello.ts');
    expect(task.currentCode).toBe('const x = 1;');
  });

  it('does not set currentCode when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const task = makeTask({ file: 'src/missing.ts' });
    refreshCurrentCode(task, '/tmp/proj');

    expect(task.currentCode).toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});

describe('allValidationsPassed', () => {
  it('returns true for empty array', () => {
    expect(allValidationsPassed([])).toBe(true);
  });

  it('returns true when all pass', () => {
    expect(allValidationsPassed([
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: true },
    ])).toBe(true);
  });

  it('returns false when any fails', () => {
    expect(allValidationsPassed([
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: false, error: 'err' },
    ])).toBe(false);
  });
});

describe('addUsageAndSave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds usage tokens and saves state', () => {
    const state = makeState({
      tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }),
    });

    const result = addUsageAndSave('/tmp/proj', state, 'planner', {
      inputTokens: 200,
      outputTokens: 100,
    });

    expect(result.tokenUsage.plannerInput).toBe(300);
    expect(result.tokenUsage.plannerOutput).toBe(150);
    expect(saveState).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledWith('/tmp/proj', result);
  });

  it('returns unchanged state when usage is null', () => {
    const state = makeState();
    const result = addUsageAndSave('/tmp/proj', state, 'implementer', null);

    expect(result).toBe(state);
    expect(saveState).toHaveBeenCalledWith('/tmp/proj', state);
  });
});

describe('withSignalHandlers', () => {
  it('registers and removes signal handlers around fn execution', async () => {
    const handler = vi.fn();
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');

    await withSignalHandlers(handler, async () => {
      // During execution, handlers should be registered
      expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    });

    // After execution, handlers should be removed
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    onSpy.mockRestore();
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
});
