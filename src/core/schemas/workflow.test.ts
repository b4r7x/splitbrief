import { describe, expect, it } from 'vitest';
import { WorkflowStateSchema } from './workflow.js';

const tokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

const task = {
  id: 'T001',
  title: 'Do work',
  action: 'modify',
  file: 'src/a.ts',
  dependsOn: [],
  description: 'Do work',
  tests: [],
  constraints: [],
  typeDefs: '',
  implementationSteps: [],
  status: 'pending',
};

describe('WorkflowStateSchema recovery compatibility', () => {
  it('parses old state without pendingRecovery', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'implementing',
      feature: 'legacy session',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pendingRecovery).toBeUndefined();
    expect(result.data.awaitingContinue).toBe(false);
    expect(result.data.messageQueue).toEqual([]);
  });

  it('parses rewound state without plannerSessionId', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'planning',
      feature: 'rewound session',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.plannerSessionId).toBeUndefined();
  });

  it('accepts state with pendingRecovery field', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'implementing',
      feature: 'recover session',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
      pendingRecovery: {
        id: 'rec_001',
        reason: 'retry-exhausted',
        phase: 'implementing',
        status: 'awaiting-user',
        files: [],
        affectedTaskIds: [],
        message: 'exhausted retries',
        details: [],
        availableActions: ['abort-workflow'],
        recommendedAction: 'abort-workflow',
        createdAt: '2026-04-28T12:00:00.000Z',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects duplicate task IDs', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'planning',
      feature: 'duplicate tasks',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [task, { ...task, title: 'Duplicate' }],
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
    });

    expect(result.success).toBe(false);
  });

  it('rejects active task phases with currentTaskIndex outside tasks', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'validating-task',
      feature: 'bad index',
      currentTaskIndex: 999,
      attempt: 0,
      tasks: [task],
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
    });

    expect(result.success).toBe(false);
  });

  it('accepts implementing state after the last task and before final review', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'implementing',
      feature: 'task boundary',
      currentTaskIndex: 1,
      attempt: 0,
      tasks: [{ ...task, status: 'done' }],
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
    });

    expect(result.success).toBe(true);
  });

  it('strips legacy clarifications and analysisResult fields from persisted state', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'planning',
      feature: 'legacy speckit session',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
      clarifications: [{ id: 'c1', question: 'q', answer: 'a' }],
      analysisResult: {
        specTaskCoverage: 1,
        planTaskCoverage: 1,
        orphanTasks: [],
        unaddressedSpecSections: [],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('clarifications');
    expect(result.data).not.toHaveProperty('analysisResult');
  });
});
