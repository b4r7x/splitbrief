import { describe, it, expect } from 'vitest';
import { buildBranchSummaryPrompt } from './summary-prompt.js';
import { entryId } from './schemas.js';

describe('buildBranchSummaryPrompt', () => {
  it('includes task title when provided', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'API timeout',
      taskTitle: 'Implement login flow',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('Implement login flow');
  });

  it('shows unknown task when title is not provided', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'API timeout',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('unknown task');
  });

  it('includes recovery reason', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'Rate limit exceeded',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('Rate limit exceeded');
  });

  it('includes entry count', () => {
    const ctx = {
      entries: [
        { id: entryId('E0001'), parentId: null, type: 'start', timestamp: 1000, payload: null },
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'message', timestamp: 2000, payload: null },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('2 entries');
  });

  it('filters out session-start entries', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'message', timestamp: 2000, payload: null },
        { id: entryId('E0001'), parentId: null, type: 'session-start', timestamp: 1000, payload: null },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('[message]');
    expect(prompt).not.toContain('[session-start]');
  });

  it('describes entries with message payload', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'message', timestamp: 2000, payload: { message: 'Hello world, this is a test message that should be included' } },
        { id: entryId('E0001'), parentId: null, type: 'session-start', timestamp: 1000, payload: null },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('Hello world, this is a test message that should be included');
    expect(prompt).not.toContain('[session-start]');
  });

  it('describes entries with title payload', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'action', timestamp: 2000, payload: { title: 'User clicked button' } },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('User clicked button');
  });

  it('truncates long message payloads to 120 chars', () => {
    const longMessage = 'a'.repeat(200);
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'message', timestamp: 2000, payload: { message: longMessage } },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    const messageLine = prompt.split('\n').find(line => line.includes('[message]'));
    expect(messageLine!.length).toBeLessThanOrEqual(132);
  });

  it('handles null payload with timestamp', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'action', timestamp: 2000, payload: null },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('(action at 1970-01-01T00:00:02.000Z)');
  });

  it('handles undefined payload with timestamp', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'action', timestamp: 2000, payload: undefined },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('(action at 1970-01-01T00:00:02.000Z)');
  });

  it('handles primitive payload by converting to string', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'result', timestamp: 2000, payload: 42 },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('[result] 42');
  });

  it('truncates primitive payloads to 80 chars', () => {
    const longString = 'b'.repeat(200);
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'result', timestamp: 2000, payload: longString },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    const resultLine = prompt.split('\n').find(line => line.includes('[result]'));
    expect(resultLine!.length).toBeLessThanOrEqual(91);
  });

  it('handles object payload without message or title', () => {
    const ctx = {
      entries: [
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'data', timestamp: 2000, payload: { foo: 'bar' } },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('[data]');
  });

  it('lists entries newest first', () => {
    const ctx = {
      entries: [
        { id: entryId('E0003'), parentId: entryId('E0002'), type: 'end', timestamp: 3000, payload: null },
        { id: entryId('E0002'), parentId: entryId('E0001'), type: 'middle', timestamp: 2000, payload: null },
        { id: entryId('E0001'), parentId: null, type: 'start', timestamp: 1000, payload: null },
      ],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    const lines = prompt.split('\n');
    const endIdx = lines.findIndex(line => line.includes('[end]'));
    const middleIdx = lines.findIndex(line => line.includes('[middle]'));
    expect(endIdx).toBeLessThan(middleIdx);
  });

  it('includes JSON schema instructions', () => {
    const ctx = {
      entries: [],
      recoveryReason: 'Error',
    };
    const prompt = buildBranchSummaryPrompt(ctx);
    expect(prompt).toContain('"goal"');
    expect(prompt).toContain('"progress"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"constraints"');
    expect(prompt).toContain('"nextSteps"');
    expect(prompt).toContain('"failureReason"');
  });
});
