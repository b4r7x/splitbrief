import { describe, it, expect, vi } from 'vitest';
import { HeadlessJsonRecordSchema } from '../public-json.js';
import { createStdoutJsonSink } from './stdout-json.js';

describe('stdoutJsonSink', () => {
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
