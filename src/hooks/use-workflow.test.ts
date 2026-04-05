import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { makeConfig } from '#testing/helpers/fixtures.js';

vi.mock('../engine/orchestrator/index.js', () => ({
  runWorkflow: () => new Promise(() => {}), // never resolves — simulates a running workflow
}));

vi.mock('../utils/process.js', () => ({
  killAllProcesses: vi.fn(),
}));

import { useWorkflow, parseReviewCommand } from './use-workflow.js';
import { workflowStore } from '../stores/workflow.js';

describe('useWorkflow', () => {
  beforeEach(() => workflowStore.reset());
  it('mounts without error and returns expected shape', () => {
    const config = makeConfig();
    const onComplete = vi.fn();

    const { result, unmount } = renderHook(() =>
      useWorkflow({
        feature: 'auth',
        projectDir: '/tmp/proj',
        config,
        onComplete,
      }),
    );

    expect(result.current.events).toEqual([]);
    expect(result.current.phase).toBe('idle');
    expect(result.current.currentTask).toBe(0);
    expect(result.current.totalTasks).toBe(0);
    expect(result.current.localCount).toBe(0);
    expect(result.current.escalatedCount).toBe(0);
    expect(result.current.inputMode).toBe('normal');
    expect(result.current.inputHint).toBe('');
    expect(result.current.reviewFilePath).toBe(null);
    expect(typeof result.current.handleInput).toBe('function');
    expect(result.current.taskMap).toBeInstanceOf(Map);
    unmount();
  });

  it('does not call onComplete on mount', () => {
    const config = makeConfig();
    const onComplete = vi.fn();

    const { unmount } = renderHook(() =>
      useWorkflow({
        feature: 'test',
        projectDir: '/tmp/proj',
        config,
        onComplete,
      }),
    );

    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });

  it('accepts resumeState and reflects initial task index', () => {
    const config = makeConfig();
    const onComplete = vi.fn();

    const { result, unmount } = renderHook(() =>
      useWorkflow({
        feature: 'auth',
        projectDir: '/tmp/proj',
        config,
        onComplete,
        resumeState: {
          stateVersion: 1,
          phase: 'implementing',
          feature: 'auth',
          currentTaskIndex: 3,
          attempt: 0,
          tasks: [
            { id: 'T1', title: 'a', action: 'create', file: 'a.ts', dependsOn: [], description: '', tests: [], constraints: [], typeDefs: '', implSteps: [], status: 'done' },
            { id: 'T2', title: 'b', action: 'create', file: 'b.ts', dependsOn: [], description: '', tests: [], constraints: [], typeDefs: '', implSteps: [], status: 'done' },
            { id: 'T3', title: 'c', action: 'create', file: 'c.ts', dependsOn: [], description: '', tests: [], constraints: [], typeDefs: '', implSteps: [], status: 'done' },
            { id: 'T4', title: 'd', action: 'create', file: 'd.ts', dependsOn: [], description: '', tests: [], constraints: [], typeDefs: '', implSteps: [], status: 'pending' },
          ],
          completedTasks: ['T1', 'T2', 'T3'],
          escalatedTasks: [],
          skippedTasks: [],
          failedTasks: [],
          sessionId: null,
          startedAt: new Date().toISOString(),
          tokenUsage: { plannerInput: 0, plannerOutput: 0, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
        },
      }),
    );

    expect(result.current.phase).toBe('implementing');
    expect(result.current.currentTask).toBe(3);
    expect(result.current.totalTasks).toBe(4);
    unmount();
  });
});

describe('parseReviewCommand', () => {
  it.each(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue'])
    ('recognizes approve alias: %s', (input) => {
      expect(parseReviewCommand(input)).toEqual({ action: 'approve' });
    });

  it.each(['quit', 'reject', 'no', 'n'])
    ('recognizes quit alias: %s', (input) => {
      expect(parseReviewCommand(input)).toEqual({ action: 'quit' });
    });

  it('recognizes edit', () => {
    expect(parseReviewCommand('edit')).toEqual({ action: 'edit' });
  });

  it('parses comment with text', () => {
    expect(parseReviewCommand('comment fix the typo')).toEqual({
      action: 'approve',
      comment: 'fix the typo',
    });
  });

  it('returns null for unknown input', () => {
    expect(parseReviewCommand('foobar')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(parseReviewCommand('APPROVE')).toEqual({ action: 'approve' });
    expect(parseReviewCommand('Quit')).toEqual({ action: 'quit' });
    expect(parseReviewCommand('EDIT')).toEqual({ action: 'edit' });
  });

  it('trims whitespace', () => {
    expect(parseReviewCommand('  approve  ')).toEqual({ action: 'approve' });
  });

  it('preserves original case in comment text', () => {
    expect(parseReviewCommand('comment Please Fix This')).toEqual({
      action: 'approve',
      comment: 'Please Fix This',
    });
  });

  it('handles leading whitespace in comment command', () => {
    expect(parseReviewCommand('  comment Keep original')).toEqual({
      action: 'approve',
      comment: 'Keep original',
    });
  });

  it('handles leading whitespace with uppercase COMMENT', () => {
    expect(parseReviewCommand('  COMMENT Preserve Case')).toEqual({
      action: 'approve',
      comment: 'Preserve Case',
    });
  });
});
