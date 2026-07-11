import { describe, it, expect } from 'vitest';
import { parseJsonlLine } from './parse-jsonl.js';

describe('parseJsonlLine — codex liveness and failure records', () => {
  it('turn.started and item.updated are consumed silently', () => {
    expect(parseJsonlLine(JSON.stringify({ type: 'turn.started' }))).toEqual({});
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.updated',
          item: { id: 'cmd-1', type: 'command_execution', status: 'in_progress' },
        }),
      ),
    ).toEqual({});
  });

  it('turn.failed and error records map to a deduplicated upstream-failure warning', () => {
    const turnFailed = parseJsonlLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }),
    );
    expect(turnFailed).toEqual({
      warning: [
        expect.objectContaining({
          code: 'jsonl_upstream_failure',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'turn.failed',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
    });

    const errorRecord = parseJsonlLine(JSON.stringify({ type: 'error', message: 'rate limited' }));
    expect(errorRecord).toEqual({
      warning: [
        expect.objectContaining({
          code: 'jsonl_upstream_failure',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'error',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
    });

    const repeat = parseJsonlLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }),
    );
    expect(repeat.warning?.[0]?.fingerprint).toBe(turnFailed.warning?.[0]?.fingerprint);
  });

  it('unknown record types still produce the deduplicated unknown-record warning', () => {
    const first = parseJsonlLine(JSON.stringify({ type: 'mystery.event', payload: 1 }));
    const second = parseJsonlLine(JSON.stringify({ type: 'mystery.event', payload: 2 }));

    expect(first).toEqual({
      warning: [
        expect.objectContaining({
          code: 'unknown_jsonl_record',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'mystery.event',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
    });
    expect(second.warning?.[0]?.fingerprint).toBe(first.warning?.[0]?.fingerprint);
  });
});
