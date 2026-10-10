import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { HeadlessJsonRecordSchema } from '../public-json.js';
import type { EngineEventOf } from '../types.js';
import { createStdoutJsonSink } from './stdout-json.js';

describe('stdoutJsonSink', () => {
  it('keeps the attached inputs of a request in the public event record', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const request: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 100,
      phase: 'planning',
      text: 'plan the receiving workflow',
      attachedInputs: [
        { path: '/Users/dev/briefs/feature.md', kind: 'text' },
        { path: '/Users/dev/Desktop/receiving-flow.png', kind: 'image' },
      ],
    };

    createStdoutJsonSink({ output })(request);

    const record = HeadlessJsonRecordSchema.parse(JSON.parse(chunks.join('').trimEnd()));
    expect(record).toEqual({ type: 'event', data: request });
  });

  it('writes one public event record per NDJSON line', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    const sink = createStdoutJsonSink();
    sink({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' });
    sink({ type: 'instant_plan_received', ts: 200, phase: 'planning', taskCount: 3 });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^\{"type":"event"/);
    expect(writes[0]).toMatch(/\n$/);
    const first = HeadlessJsonRecordSchema.parse(JSON.parse(writes[0]!.trimEnd()));
    const second = HeadlessJsonRecordSchema.parse(JSON.parse(writes[1]!.trimEnd()));
    expect(first).toEqual({
      type: 'event',
      data: { type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' },
    });
    expect(
      second.type === 'event' && second.data.type === 'instant_plan_received'
        ? second.data.taskCount
        : undefined,
    ).toBe(3);

    spy.mockRestore();
  });
});
