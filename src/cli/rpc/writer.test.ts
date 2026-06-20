import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../engine/events/types.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../engine/events/protection.js';
import { taskId } from '../../core/schemas/task.js';
import { createResponseWriter } from './writer.js';

function createCaptureStream(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return { chunks, stream };
}

function parseJsonLines(chunks: string[]): unknown[] {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('createResponseWriter', () => {
  it('writes ack, error, status, and event responses as JSON lines', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({ stream, onClose: () => {} });
    const event = {
      type: 'warning',
      ts: 1,
      phase: 'planning',
      message: 'watch this',
    } satisfies EngineEvent;

    writer.ack('approve');
    writer.error('bad command');
    writer.status({ phase: 'planning' });
    writer.event(event);

    expect(chunks.every((chunk) => chunk.endsWith('\n'))).toBe(true);
    expect(parseJsonLines(chunks)).toEqual([
      { type: 'ack', command: 'approve' },
      { type: 'error', error: 'bad command' },
      { type: 'status', data: { phase: 'planning' } },
      { type: 'event', data: event },
    ]);
  });

  it('keeps embedded newlines inside a single JSON response line', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({ stream, onClose: () => {} });

    writer.status({ message: 'line one\nline two' });

    const output = chunks.join('');
    expect(output.split('\n')).toHaveLength(2);
    expect(parseJsonLines(chunks)).toEqual([
      { type: 'status', data: { message: 'line one\nline two' } },
    ]);
  });

  it('protects live event responses with the RPC transcript policy', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });

    writer.event({
      type: 'runner_call_text_delta',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      channel: 'assistant',
      text: 'hidden transcript',
    });
    writer.event({
      type: 'runner_call_activity',
      ts: 2,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      activityId: 'call-1:tool:tool-1',
      stage: 'completed',
      kind: 'command',
      label: 'running echo sk-abcdefghijklmnopqrst',
      target: 'echo sk-abcdefghijklmnopqrst',
      redacted: false,
    });
    writer.event({
      type: 'task_retry',
      ts: 3,
      phase: 'implementing',
      taskId: taskId('T001'),
      attempt: 2,
      maxRetries: 3,
      error: 'rpc-live-retry-secret-98324',
    });

    const lines = parseJsonLines(chunks);
    expect(lines).toEqual([
      {
        type: 'event',
        data: expect.objectContaining({
          type: 'runner_call_activity',
          label: TRANSCRIPT_OMITTED_MESSAGE,
          target: TRANSCRIPT_OMITTED_MESSAGE,
        }),
      },
      {
        type: 'event',
        data: expect.objectContaining({
          type: 'task_retry',
          taskId: 'T001',
          attempt: 2,
          maxRetries: 3,
          error: TRANSCRIPT_OMITTED_MESSAGE,
        }),
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('rpc-live-retry-secret-98324');
  });

  it('omits transcript-bearing status fields when transcript persistence is disabled', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });

    writer.status({
      sessionId: 'session-1',
      phase: 'planning',
      state: { feature: 'secret feature prompt' },
      question: 'secret question',
      issue: {
        id: 'rec-rpc-1',
        reason: 'retry-exhausted',
        phase: 'implementing',
        status: 'awaiting-user',
        taskId: 'T001',
        taskTitle: 'rpc-recovery-task-secret-29140',
        files: ['src/target.ts'],
        affectedTaskIds: ['T001'],
        message: 'rpc-recovery-message-secret-29140',
        details: ['rpc-recovery-detail-secret-29140'],
        attempts: 3,
        maxAttempts: 3,
        selectedImplementerProfile: 'local-small',
        availableActions: ['retry-same-worker', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
      queueDepth: 0,
    });

    const lines = parseJsonLines(chunks);
    expect(lines).toEqual([
      {
        type: 'status',
        data: {
          sessionId: 'session-1',
          phase: 'planning',
          state: null,
          question: '[transcript omitted]',
          issue: {
            id: 'rec-rpc-1',
            reason: 'retry-exhausted',
            phase: 'implementing',
            status: 'awaiting-user',
            taskId: 'T001',
            taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
            files: ['src/target.ts'],
            affectedTaskIds: ['T001'],
            message: TRANSCRIPT_OMITTED_MESSAGE,
            details: [TRANSCRIPT_OMITTED_MESSAGE],
            attempts: 3,
            maxAttempts: 3,
            selectedImplementerProfile: 'local-small',
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
          queueDepth: 0,
          transcript: '[transcript omitted]',
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('rpc-recovery-message-secret-29140');
    expect(JSON.stringify(lines)).not.toContain('rpc-recovery-detail-secret-29140');
    expect(JSON.stringify(lines)).not.toContain('rpc-recovery-task-secret-29140');
  });
});
