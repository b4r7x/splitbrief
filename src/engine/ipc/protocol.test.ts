import { describe, expect, it } from 'vitest';
import { parseIpcPromptResponse, parseServerMessage } from './protocol.js';

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
    expect(parseIpcPromptResponse({
      kind: 'task_review',
      response: { action: 'invalid-action' },
    })).toBeNull();
  });

  it('rejects task_review with non-object response', () => {
    expect(parseIpcPromptResponse({
      kind: 'task_review',
      response: 'continue',
    })).toBeNull();
  });

  it('rejects task_review with non-string notes', () => {
    expect(parseIpcPromptResponse({
      kind: 'task_review',
      response: { action: 'continue', notes: 42 },
    })).toBeNull();
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
      readonly: false,
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects session_meta with missing fields', () => {
    expect(parseServerMessage({ kind: 'session_meta', sessionId: 'sess-1' })).toBeNull();
  });

  it('parses valid event message', () => {
    const msg = {
      kind: 'event',
      payload: { type: 'phase_changed', ts: 1000, phase: 'planning' },
    };
    expect(parseServerMessage(msg)).toEqual(msg);
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
      request: { requestId: 'req-1', kind: 'external_changes' },
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects prompt_request with missing requestId', () => {
    expect(parseServerMessage({ kind: 'prompt_request', request: { kind: 'external_changes' } })).toBeNull();
  });

  it('parses valid replay_meta message', () => {
    const msg = { kind: 'replay_meta', totalEvents: 5, firstTs: 100, lastTs: 200 };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects replay_meta with non-number totalEvents', () => {
    expect(parseServerMessage({ kind: 'replay_meta', totalEvents: 'five' })).toBeNull();
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
