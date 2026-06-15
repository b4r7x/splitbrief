import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseIpcPromptResponse, parseServerMessage } from './protocol.js';

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
