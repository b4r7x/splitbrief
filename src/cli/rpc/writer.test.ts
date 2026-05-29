import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../engine/events/types.js';
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
    const writer = createResponseWriter(stream);
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
    const writer = createResponseWriter(stream);

    writer.status({ message: 'line one\nline two' });

    const output = chunks.join('');
    expect(output.split('\n')).toHaveLength(2);
    expect(parseJsonLines(chunks)).toEqual([
      { type: 'status', data: { message: 'line one\nline two' } },
    ]);
  });
});
