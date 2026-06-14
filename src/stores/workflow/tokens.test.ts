import { describe, it, expect, beforeEach } from 'vitest';
import { tokensStore } from './tokens.js';
import { addEvent, resetWorkflow } from './actions.js';
import { makeTaskComplete, makeCostUpdate, makeTaskSkipped } from '#testing/helpers/events.js';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEvent } from '../../engine/events/types.js';

function makeTaskTokens(overrides?: Partial<EngineEvent & { type: 'task_tokens' }>): EngineEvent {
  return {
    type: 'task_tokens',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    method: 'local',
    implementerTokens: 100,
    escalationTokens: 0,
    retryCount: 0,
    ...overrides,
  };
}

function makeTaskReset(id = 'T001'): EngineEvent {
  return { type: 'task_reset', ts: Date.now(), phase: 'implementing', taskId: taskId(id) };
}

describe('tokensStore — cost-update', () => {
  beforeEach(() => resetWorkflow());

  it('sets tokenUsage and overwrites on subsequent cost-update', () => {
    const first = makeCostUpdate();
    addEvent(first);
    expect(tokensStore.get().tokenUsage).toEqual(first.tokenUsage);

    const updated = {
      plannerInput: 999,
      plannerOutput: 999,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    };
    addEvent(makeCostUpdate({ tokenUsage: updated }));
    expect(tokensStore.get().tokenUsage).toEqual(updated);
  });
});

describe('tokensStore — task-complete counters', () => {
  beforeEach(() => resetWorkflow());

  it.each([
    { method: 'local' as const, localCount: 1, escalatedCount: 0 },
    { method: 'escalated-hint' as const, localCount: 0, escalatedCount: 1 },
    { method: 'escalated-full' as const, localCount: 0, escalatedCount: 1 },
    { method: 'failed' as const, localCount: 0, escalatedCount: 0 },
    { method: 'skipped' as const, localCount: 0, escalatedCount: 0 },
  ])('method=$method → local=$localCount, escalated=$escalatedCount', ({
    method,
    localCount,
    escalatedCount,
  }) => {
    addEvent(makeTaskComplete({ method }));
    const s = tokensStore.get();
    expect(s.localCount).toBe(localCount);
    expect(s.escalatedCount).toBe(escalatedCount);
  });

  it('does not count workflow lifecycle events as completed tasks', () => {
    addEvent({ type: 'workflow_started', ts: Date.now(), phase: 'idle', feature: 'test' });

    expect(tokensStore.get().completedTaskCount).toBe(0);
  });

  it('counts skipped tasks as completed task slots', () => {
    addEvent(makeTaskSkipped());

    expect(tokensStore.get().completedTaskCount).toBe(1);
  });
});

describe('tokensStore — per-task attempt accumulation', () => {
  beforeEach(() => resetWorkflow());

  it('keeps one attempt record per task_tokens event and sums tokens for display', () => {
    addEvent(makeTaskTokens({ implementerTokens: 100, tool: 'deepseek', model: 'deepseek-chat' }));
    addEvent(
      makeTaskTokens({
        implementerTokens: 250,
        retryCount: 1,
        tool: 'claude-code',
        model: 'claude-opus-4-6',
      }),
    );

    const record = tokensStore.get().perTask['T001'];
    expect(record?.totalTokens).toBe(350);
    expect(record?.attempts).toHaveLength(2);
    expect(record?.attempts?.map((a) => a.tool)).toEqual(['deepseek', 'claude-code']);
    expect(record?.attempts?.map((a) => a.model)).toEqual(['deepseek-chat', 'claude-opus-4-6']);
  });

  it('task_reset undoes the prior completion counters so a redo does not double-count', () => {
    addEvent(makeTaskComplete({ method: 'local' }));
    addEvent(makeTaskTokens({ method: 'local', implementerTokens: 100 }));
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().completedTaskCount).toBe(1);

    addEvent(makeTaskReset());
    expect(tokensStore.get().localCount).toBe(0);
    expect(tokensStore.get().completedTaskCount).toBe(0);

    addEvent(makeTaskComplete({ method: 'local' }));
    addEvent(makeTaskTokens({ method: 'local', implementerTokens: 200, retryCount: 0 }));
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().completedTaskCount).toBe(1);

    const record = tokensStore.get().perTask['T001'];
    expect(record?.attempts).toHaveLength(2);
    expect(record?.totalTokens).toBe(300);
  });

  it('task_reset undoes an escalated completion when the last attempt escalated', () => {
    addEvent(makeTaskComplete({ method: 'escalated-full' }));
    addEvent(
      makeTaskTokens({ method: 'escalated-full', implementerTokens: 0, escalationTokens: 80 }),
    );
    expect(tokensStore.get().escalatedCount).toBe(1);

    addEvent(makeTaskReset());
    expect(tokensStore.get().escalatedCount).toBe(0);
    expect(tokensStore.get().completedTaskCount).toBe(0);
  });

  it('task_reset for a never-completed task leaves earlier tasks counted (recovery retry path)', () => {
    addEvent(makeTaskComplete({ method: 'local', taskId: taskId('T001') }));
    addEvent(makeTaskTokens({ taskId: taskId('T001'), method: 'local', implementerTokens: 100 }));
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().completedTaskCount).toBe(1);

    addEvent(makeTaskReset('T002'));

    const s = tokensStore.get();
    expect(s.completedTaskCount).toBe(1);
    expect(s.localCount).toBe(1);
    expect(s.escalatedCount).toBe(0);
  });
});
