import { describe, it, expect, vi } from 'vitest';
import { createStdoutJsonSink } from './stdout-json.js';

describe('stdoutJsonSink', () => {
  it('writes one NDJSON line per event', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    const sink = createStdoutJsonSink();
    sink({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' });
    sink({ type: 'plan_done', ts: 200, phase: 'planning', taskCount: 3 });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^\{"type":"workflow_started"/);
    expect(writes[0]).toMatch(/\n$/);
    expect(JSON.parse(writes[0]!.trimEnd()).feature).toBe('x');
    expect(JSON.parse(writes[1]!.trimEnd()).taskCount).toBe(3);

    spy.mockRestore();
  });
});
