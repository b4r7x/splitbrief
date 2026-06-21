import { describe, expect, it } from 'vitest';
import { USER_EDIT_CONFLICT_ACTIONS } from '../../core/schemas/enums.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { TASK_REVIEW_COMMANDS } from '../events/workflow-events.js';
import { parseClientMessage, parseIpcPromptResponse, parseServerMessage } from './protocol.js';

function taskReviewRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'T001',
    taskTitle: 'Review task',
    status: 'recovery-required',
    filesTouched: ['src/task.ts'],
    validation: { passed: false, summary: 'validation failed', stages: [] },
    evidence: { summary: 'needs review', expected: [], observed: [] },
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
    availableCommands: [...TASK_REVIEW_COMMANDS],
    ...overrides,
  };
}

function taskReviewEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'task_review_needed',
    ts: 1,
    phase: 'implementing',
    ...taskReviewRequest(overrides),
  };
}

describe('parseClientMessage', () => {
  it('parses detach', () => {
    expect(parseClientMessage({ kind: 'detach' })).toEqual({ kind: 'detach' });
  });

  it('parses user_input', () => {
    expect(parseClientMessage({ kind: 'user_input', text: 'hello' })).toEqual({
      kind: 'user_input',
      text: 'hello',
    });
  });

  it('rejects the removed recovery_response command', () => {
    expect(
      parseClientMessage({ kind: 'recovery_response', issueId: 'i1', action: 'pause' }),
    ).toBeNull();
  });
});

describe('parseIpcPromptResponse — cost_approval', () => {
  it('parses valid cost_approval response', () => {
    expect(parseIpcPromptResponse({ kind: 'cost_approval', approved: true })).toEqual({
      kind: 'cost_approval',
      approved: true,
    });
  });

  it('rejects cost_approval with non-boolean approved', () => {
    expect(parseIpcPromptResponse({ kind: 'cost_approval', approved: 'yes' })).toBeNull();
  });

  it('rejects cost_approval with missing approved', () => {
    expect(parseIpcPromptResponse({ kind: 'cost_approval' })).toBeNull();
  });
});

describe('parseIpcPromptResponse — task_review', () => {
  it.each(
    TASK_REVIEW_COMMANDS.filter((command) => command !== 'edit-notes'),
  )('parses task_review response action %s from the shared command contract', (action) => {
    expect(parseIpcPromptResponse({ kind: 'task_review', response: { action } })).toEqual({
      kind: 'task_review',
      response: { action },
    });
  });

  it('parses valid task_review response with continue action', () => {
    const result = parseIpcPromptResponse({
      kind: 'task_review',
      response: { action: 'continue' },
    });
    expect(result).toEqual({
      kind: 'task_review',
      response: { action: 'continue' },
    });
  });

  it('parses valid task_review response with notes', () => {
    const result = parseIpcPromptResponse({
      kind: 'task_review',
      response: { action: 'redo-task', notes: 'fix the edge case' },
    });
    expect(result).toEqual({
      kind: 'task_review',
      response: { action: 'redo-task', notes: 'fix the edge case' },
    });
  });

  it('rejects task_review with invalid action', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'task_review',
        response: { action: 'invalid-action' },
      }),
    ).toBeNull();
  });

  it('rejects edit-notes as a prompt command, not a response action', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'task_review',
        response: { action: 'edit-notes' },
      }),
    ).toBeNull();
  });

  it('rejects task_review with non-object response', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'task_review',
        response: 'continue',
      }),
    ).toBeNull();
  });

  it('rejects task_review with non-string notes', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'task_review',
        response: { action: 'continue', notes: 42 },
      }),
    ).toBeNull();
  });
});

describe('parseIpcPromptResponse — user_edit_conflict', () => {
  it.each(
    USER_EDIT_CONFLICT_ACTIONS,
  )('parses conflict action %s from the shared schema', (action) => {
    expect(parseIpcPromptResponse({ kind: 'user_edit_conflict', selectedAction: action })).toEqual({
      kind: 'user_edit_conflict',
      selectedAction: action,
    });
  });

  it('parses a valid conflict action', () => {
    expect(
      parseIpcPromptResponse({ kind: 'user_edit_conflict', selectedAction: 'continue-unrelated' }),
    ).toEqual({ kind: 'user_edit_conflict', selectedAction: 'continue-unrelated' });
  });

  it('rejects the removed regenerate-rebase action', () => {
    expect(
      parseIpcPromptResponse({ kind: 'user_edit_conflict', selectedAction: 'regenerate-rebase' }),
    ).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it('returns null for non-object values', () => {
    expect(parseServerMessage(null)).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage('string')).toBeNull();
    expect(parseServerMessage([])).toBeNull();
  });

  it('returns null for object without kind', () => {
    expect(parseServerMessage({ foo: 'bar' })).toBeNull();
  });

  it('returns null for unknown kind', () => {
    expect(parseServerMessage({ kind: 'unknown_kind' })).toBeNull();
  });

  it('parses valid session_meta message', () => {
    const msg = {
      kind: 'session_meta',
      sessionId: 'sess-1',
      startedAt: 1000,
      mode: 'standard',
      feature: 'test',
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects session_meta with missing fields', () => {
    expect(parseServerMessage({ kind: 'session_meta', sessionId: 'sess-1' })).toBeNull();
  });

  it('parses valid event message', () => {
    const msg = {
      kind: 'event',
      payload: { type: 'warning', ts: 1000, phase: 'planning', message: 'heads up' },
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('parses task_review events with legal recovery metadata', () => {
    const msg = {
      kind: 'event',
      payload: taskReviewEvent({
        recovery: {
          reason: 'budget-exceeded',
          message: 'Budget exceeded',
          availableActions: ['pause-run', 'abort-workflow'],
          recommendedAction: 'pause-run',
        },
      }),
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects task_review events with recovery actions illegal for the reason', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: taskReviewEvent({
          recovery: {
            reason: 'budget-exceeded',
            message: 'Budget exceeded',
            availableActions: ['continue'],
            recommendedAction: 'continue',
          },
        }),
      }),
    ).toBeNull();
  });

  it('rejects task_review events with a recommended recovery action not advertised', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: taskReviewEvent({
          recovery: {
            reason: 'validation-failed',
            message: 'Validation failed',
            availableActions: ['retry-same-worker'],
            recommendedAction: 'route-bigger-worker',
          },
        }),
      }),
    ).toBeNull();
  });

  it('rejects event with unknown payload type', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: { type: 'not_real', ts: 1000, phase: 'planning' },
      }),
    ).toBeNull();
  });

  it('rejects event with missing variant fields', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: { type: 'task_completed', ts: 1000, phase: 'implementing' },
      }),
    ).toBeNull();
  });

  it('rejects event with non-object payload', () => {
    expect(parseServerMessage({ kind: 'event', payload: 'bad' })).toBeNull();
  });

  it('rejects event with payload missing type', () => {
    expect(parseServerMessage({ kind: 'event', payload: { ts: 1000 } })).toBeNull();
  });

  it('rejects event with payload missing ts', () => {
    expect(parseServerMessage({ kind: 'event', payload: { type: 'foo' } })).toBeNull();
  });

  it('parses valid prompt_request message', () => {
    const msg = {
      kind: 'prompt_request',
      request: { requestId: 'req-1', kind: 'approval_needed', approvalType: 'spec', filePath: 's' },
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('parses recovery prompt requests with IPC-safe context fields only', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-recovery',
        kind: 'recovery_needed',
        issue: {
          id: 'rec-1',
          reason: 'retry-exhausted',
          phase: 'implementing',
          taskId: 'T001',
          taskTitle: 'Fix auth',
          files: ['src/auth.ts'],
          affectedTaskIds: ['T001'],
          selectedImplementerProfile: 'local-small',
          availableActions: ['retry-same-worker', 'route-bigger-worker', 'abort-workflow'],
          recommendedAction: 'route-bigger-worker',
          workerProfile: 'local-large',
          facts: { safeToContinue: false },
        },
      },
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('parses transcript-projected recovery and conflict prompt requests', () => {
    const recovery = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-recovery',
        kind: 'recovery_needed',
        issue: {
          id: 'rec-1',
          reason: 'retry-exhausted',
          phase: 'implementing',
          taskId: 'T001',
          taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
          files: ['src/task.ts'],
          affectedTaskIds: ['T001'],
          availableActions: ['retry-same-worker', 'abort-workflow'],
          recommendedAction: 'retry-same-worker',
        },
      },
    };
    const conflict = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-conflict',
        kind: 'user_edit_conflict',
        conflict: {
          kind: 'current-task-conflict',
          files: [TRANSCRIPT_OMITTED_MESSAGE],
          affectedTaskIds: ['T001'],
          currentTaskId: 'T001',
          fileConflicts: [
            {
              file: TRANSCRIPT_OMITTED_MESSAGE,
              kind: 'current-task-conflict',
              affectedTaskIds: ['T001'],
            },
          ],
          safeToContinue: false,
          availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
        },
      },
    };

    expect(parseServerMessage(recovery)).toEqual(recovery);
    expect(parseServerMessage(conflict)).toEqual(conflict);
  });

  it('rejects recovery prompt requests with prose message or details', () => {
    const baseIssue = {
      id: 'rec-1',
      reason: 'retry-exhausted',
      phase: 'implementing',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'abort-workflow'],
      recommendedAction: 'retry-same-worker',
    };

    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-recovery',
          kind: 'recovery_needed',
          issue: { ...baseIssue, message: 'freeform prose' },
        },
      }),
    ).toBeNull();
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-recovery',
          kind: 'recovery_needed',
          issue: { ...baseIssue, details: ['freeform prose'] },
        },
      }),
    ).toBeNull();
  });

  it('parses task_review prompt requests with legal recovery metadata', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-review',
        kind: 'task_review',
        request: taskReviewRequest({
          recovery: {
            reason: 'budget-exceeded',
            message: 'Budget exceeded',
            availableActions: ['pause-run', 'abort-workflow'],
            recommendedAction: 'pause-run',
          },
        }),
      },
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects task_review prompt requests with recovery actions illegal for the reason', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-review',
          kind: 'task_review',
          request: taskReviewRequest({
            recovery: {
              reason: 'budget-exceeded',
              message: 'Budget exceeded',
              availableActions: ['continue'],
              recommendedAction: 'continue',
            },
          }),
        },
      }),
    ).toBeNull();
  });

  it('rejects task_review prompt requests with a recommended recovery action not advertised', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-review',
          kind: 'task_review',
          request: taskReviewRequest({
            recovery: {
              reason: 'validation-failed',
              message: 'Validation failed',
              availableActions: ['retry-same-worker'],
              recommendedAction: 'route-bigger-worker',
            },
          }),
        },
      }),
    ).toBeNull();
  });

  it('rejects prompt_request with missing requestId', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: { kind: 'approval_needed', approvalType: 'spec', filePath: 's' },
      }),
    ).toBeNull();
  });

  it('rejects the removed external_changes prompt kind', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: { requestId: 'req-1', kind: 'external_changes' },
      }),
    ).toBeNull();
    expect(parseIpcPromptResponse({ kind: 'external_changes', proceed: true })).toBeNull();
  });

  it('rejects the removed replay_meta message kind', () => {
    expect(
      parseServerMessage({ kind: 'replay_meta', totalEvents: 5, firstTs: 100, lastTs: 200 }),
    ).toBeNull();
  });

  it('parses valid error message', () => {
    const msg = { kind: 'error', code: 'already_attached', message: 'Client already connected' };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects error with wrong code', () => {
    expect(parseServerMessage({ kind: 'error', code: 'other', message: 'fail' })).toBeNull();
  });

  it('rejects error with missing message', () => {
    expect(parseServerMessage({ kind: 'error', code: 'already_attached' })).toBeNull();
  });
});
