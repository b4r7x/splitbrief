import { describe, expect, it } from 'vitest';
import { USER_EDIT_CONFLICT_ACTIONS } from '../../core/schemas/enums.js';
import { TASK_REVIEW_COMMANDS } from '../events/workflow-events.js';
import { parseClientMessage, parseIpcPromptResponse } from './protocol.js';

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

describe('parseIpcPromptResponse — approval_needed', () => {
  it('parses command-form brief review approval responses', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: { action: 'approve' },
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: { action: 'approve' },
    });
  });

  it('parses command-form brief review revise responses with task ids', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: { action: 'revise', comment: 'split the task', taskIds: ['T001'] },
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: { action: 'revise', comment: 'split the task', taskIds: ['T001'] },
    });
  });

  it('parses command-form external edit and save draft responses', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: { action: 'external_edit_applied' },
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: { action: 'external_edit_applied' },
    });
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: { action: 'save_draft' },
      }),
    ).toEqual({
      kind: 'approval_needed',
      command: { action: 'save_draft' },
    });
  });

  it('rejects command-form revise responses with invalid task ids', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        command: { action: 'revise', comment: 'split', taskIds: ['task-1'] },
      }),
    ).toBeNull();
  });

  it('parses revise feedback as an approval prompt response action', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: false,
        action: 'revise',
        comment: 'add evidence',
      }),
    ).toEqual({
      kind: 'approval_needed',
      approved: false,
      action: 'revise',
      comment: 'add evidence',
    });
  });

  it('parses non-command revise feedback with targeted task ids', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: false,
        action: 'revise',
        comment: 'add evidence',
        taskIds: ['T001', 'T002'],
      }),
    ).toEqual({
      kind: 'approval_needed',
      approved: false,
      action: 'revise',
      comment: 'add evidence',
      taskIds: ['T001', 'T002'],
    });
  });

  it('rejects non-command revise feedback with invalid task ids', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: false,
        action: 'revise',
        comment: 'add evidence',
        taskIds: ['task-1'],
      }),
    ).toBeNull();
  });

  it('rejects revise feedback without a comment', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: false,
        action: 'revise',
      }),
    ).toBeNull();
  });

  it('rejects revise feedback with an empty comment', () => {
    expect(
      parseIpcPromptResponse({
        kind: 'approval_needed',
        approved: false,
        action: 'revise',
        comment: '  ',
      }),
    ).toBeNull();
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
  it.each(
    TASK_REVIEW_COMMANDS.filter((command) => command !== 'edit-notes'),
  )('parses task_review response action %s from the shared command contract', (action) => {
    expect(parseIpcPromptResponse({ kind: 'task_review', response: { action } })).toEqual({
      kind: 'task_review',
      response: { action },
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
