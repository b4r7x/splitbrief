import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../core/approval/types.js';
import { taskId } from '../../core/schemas/task.js';
import { createWorkflowCallbacks } from './callbacks.js';

describe('createWorkflowCallbacks confirm-tier RPC approval', () => {
  const confirmRequest: TieredApprovalRequest = {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription: 'delete files',
    phase: 'implementing',
  };

  it('denies confirm tier when RPC approve omits phrase and reason', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    const response = await callbacks.onTieredApproval?.(confirmRequest);
    expect(response).toEqual({ decision: 'deny', reason: 'invalid_confirm_phrase' });
  });

  it('accepts confirm tier when RPC approve supplies phrase and reason', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({
        approved: true,
        confirmationPhrase: CONFIRM_PHRASE,
        confirmationReason: 'reviewed diff',
      }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    const response = await callbacks.onTieredApproval?.(confirmRequest);
    expect(response).toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'reviewed diff',
    });
  });

  it('passes brief external edits through to the approval re-read loop', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: false, action: 'edit' }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    await expect(callbacks.onApprovalNeeded('briefs', '/tmp/tasks.md')).resolves.toEqual({
      approved: false,
      action: 'edit',
    });
  });

  it('returns a stable brief refusal without starting another callback flow', async () => {
    const waitForApproval = vi.fn(async (data: unknown) => {
      expect(data).toEqual({
        pending: 'approval',
        approvalType: 'briefs',
        filePath: '/tmp/tasks.md',
      });
      return { approved: false } as const;
    });
    const waitForMessage = vi.fn(async () => 'unexpected');
    const reportError = vi.fn();
    const callbacks = createWorkflowCallbacks({ waitForApproval, waitForMessage, reportError });

    await expect(callbacks.onApprovalNeeded('briefs', '/tmp/tasks.md')).resolves.toEqual({
      approved: false,
    });
    expect(waitForApproval).toHaveBeenCalledTimes(1);
    expect(waitForMessage).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('forwards immutable artifact review text to the RPC approval status without a path', async () => {
    const review = Object.freeze({
      label: 'Custom planner artifact',
      text: '# exact artifact\n\u0000no pathname\n',
    });
    const waitForApproval = vi.fn(async () => ({ approved: true }) as const);
    const callbacks = createWorkflowCallbacks({
      waitForApproval,
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    await expect(callbacks.onApprovalNeeded('artifact', review)).resolves.toEqual({
      approved: true,
    });
    expect(waitForApproval).toHaveBeenCalledWith({
      pending: 'approval',
      approvalType: 'artifact',
      review,
    });
  });

  it('passes targeted brief revision task ids through to the approval loop', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({
        approved: false,
        action: 'revise',
        comment: 'focus this brief',
        taskIds: [taskId('T002')],
      }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    await expect(callbacks.onApprovalNeeded('briefs', '/tmp/tasks.md')).resolves.toEqual({
      approved: false,
      action: 'revise',
      comment: 'focus this brief',
      taskIds: [taskId('T002')],
    });
  });

  it('re-prompts task review RPC answers outside availableCommands', async () => {
    const reportError = vi.fn();
    const messages = ['abort', 'continue'];
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => messages.shift() ?? 'continue',
      reportError,
    });

    await expect(
      callbacks.onTaskReviewNeeded?.({
        taskId: taskId('T001'),
        taskTitle: 'Review RPC command scope',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 0,
            implementerOutput: 0,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue'],
      }),
    ).resolves.toEqual({ action: 'continue' });
    expect(reportError).toHaveBeenCalledWith('Invalid task review response. Use: continue.');
  });

  it('returns advertised task review abort over RPC without host side effects', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => 'abort',
      reportError: () => undefined,
    });

    await expect(
      callbacks.onTaskReviewNeeded?.({
        taskId: taskId('T001'),
        taskTitle: 'Review RPC abort',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 0,
            implementerOutput: 0,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue', 'abort'],
      }),
    ).resolves.toEqual({ action: 'abort' });
  });

  it('accepts advertised task review notes over RPC', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => 'notes keep this context',
      reportError: () => undefined,
    });

    await expect(
      callbacks.onTaskReviewNeeded?.({
        taskId: taskId('T001'),
        taskTitle: 'Review RPC notes',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 0,
            implementerOutput: 0,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue', 'edit-notes'],
      }),
    ).resolves.toEqual({ action: 'continue', notes: 'keep this context' });
  });
});
