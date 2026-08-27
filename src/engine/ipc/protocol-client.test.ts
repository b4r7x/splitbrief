import { describe, expect, it } from 'vitest';
import { USER_EDIT_CONFLICT_ACTIONS } from '../../core/schemas/enums.js';
import { TASK_REVIEW_COMMANDS } from '../events/workflow-events.js';
import { parseClientMessage, parseIpcPromptResponse } from './protocol.js';

const BRIEF_HASH = 'a'.repeat(64);

function briefCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessionId: 'session-1',
    epochId: 'epoch-1',
    operationId: 'operation-1',
    expectedBriefRevision: 2,
    expectedReportRevision: 2,
    intentHash: BRIEF_HASH,
    base: { revision: 2, hash: BRIEF_HASH, path: 'brief/tasks.md' },
    ...overrides,
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

  it('round-trips a comment-free retry with its operation identity', () => {
    const response = {
      kind: 'approval_needed' as const,
      command: briefCommand({
        action: 'retry',
        diagnosticFingerprint: BRIEF_HASH,
        frozenInputIds: ['input-1'],
      }),
    };
    const parsed = parseIpcPromptResponse(JSON.parse(JSON.stringify(response)));

    expect(parsed).toEqual(response);
  });

  it('rejects retry commands without the current identity envelope', () => {
    const command = briefCommand({
      action: 'retry',
      diagnosticFingerprint: BRIEF_HASH,
      frozenInputIds: [],
    });
    delete command.epochId;

    expect(parseIpcPromptResponse({ kind: 'approval_needed', command })).toBeNull();
  });

  it('rejects oversized comments and duplicate frozen input IDs', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: briefCommand({ action: 'comment', comment: 'x'.repeat(4_097) }),
      }),
    ).toBeNull();
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: briefCommand({
          action: 'retry',
          diagnosticFingerprint: BRIEF_HASH,
          frozenInputIds: ['input-1', 'input-1'],
        }),
      }),
    ).toBeNull();
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

describe('parseIpcPromptResponse — approval_needed', () => {
  it('parses command-form brief review approval responses', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: briefCommand({ action: 'approve' }),
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: briefCommand({ action: 'approve' }),
    });
  });

  it('parses command-form brief review comments with the current report revision', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: briefCommand({ action: 'comment', comment: 'split the task' }),
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: briefCommand({ action: 'comment', comment: 'split the task' }),
    });
  });

  it('parses command-form edit and status responses', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: briefCommand({
          action: 'edit',
          briefText: 'updated brief',
          newInputId: 'input-2',
        }),
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: briefCommand({ action: 'edit', briefText: 'updated brief', newInputId: 'input-2' }),
    });
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: {
          version: 1,
          sessionId: 'session-1',
          epochId: 'epoch-1',
          action: 'status',
        },
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: {
        version: 1,
        sessionId: 'session-1',
        epochId: 'epoch-1',
        action: 'status',
      },
    });
  });

  it('rejects command-form edits with an empty Brief or missing input identity', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: briefCommand({ action: 'edit', briefText: '', newInputId: 'input-2' }),
      }),
    ).toBeNull();
    const missingInputId = briefCommand({ action: 'edit', briefText: 'updated brief' });
    expect(parseIpcPromptResponse({ kind: 'approval_needed', command: missingInputId })).toBeNull();
  });

  it('rejects approved responses with review comments', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: true,
        comment: 'approve but also revise',
      }),
    ).toBeNull();
  });

  it('rejects comment-only review feedback', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: false,
        comment: 'add evidence',
      }),
    ).toBeNull();
  });
});

describe('parseIpcPromptResponse — task_review', () => {
  it.each(TASK_REVIEW_COMMANDS.filter((command) => command !== 'edit-notes'))(
    'parses task_review response action %s from the shared command contract',
    (action) => {
      expect(parseIpcPromptResponse({ kind: 'task_review', response: { action } })).toEqual({
        kind: 'task_review',
        response: { action },
      });
    },
  );

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
  it.each(USER_EDIT_CONFLICT_ACTIONS)(
    'parses conflict action %s from the shared schema',
    (action) => {
      expect(
        parseIpcPromptResponse({ kind: 'user_edit_conflict', selectedAction: action }),
      ).toEqual({
        kind: 'user_edit_conflict',
        selectedAction: action,
      });
    },
  );

  it('rejects the removed regenerate-rebase action', () => {
    expect(
      parseIpcPromptResponse({ kind: 'user_edit_conflict', selectedAction: 'regenerate-rebase' }),
    ).toBeNull();
  });
});

describe('parseIpcPromptResponse — removed kinds', () => {
  it('rejects the removed external_changes prompt response', () => {
    expect(parseIpcPromptResponse({ kind: 'external_changes', proceed: true })).toBeNull();
  });
});
