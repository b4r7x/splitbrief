import { describe, expect, it } from 'vitest';
import { rowText } from '../row-format/rows.js';
import type { ConversationRow, ConversationRowBlock } from '../types.js';
import { queueRowBlock } from './queue.js';

function rows(block: ConversationRowBlock | null): ConversationRow[] {
  return block === null ? [] : block.createRows(0, block.rowCount);
}

describe('queueRowBlock', () => {
  it('heads a queued message in the info tone above the message text', () => {
    const queued = rows(
      queueRowBlock(
        'queue',
        {
          type: 'message_queued',
          ts: 0,
          phase: 'implementing',
          seat: 'build',
          taskId: 'T003',
          id: 'm-1',
          preview: 'smaller diffs',
        },
        120,
      ),
    );

    expect(queued.map(rowText)).toEqual([
      'Queued for BUILD on T003 · read when its call ends',
      'smaller diffs',
    ]);
    expect(queued[0]?.markerTone).toBe('info');
    expect(queued[0]?.segments.map((segment) => segment.tone)).toEqual(['info', 'textDim']);
    expect(queued[1]?.segments.map((segment) => segment.tone)).toEqual(['text']);
  });

  it('heads a clarification answer as answered, not queued', () => {
    const answered = rows(
      queueRowBlock(
        'queue',
        {
          type: 'message_queued',
          ts: 0,
          phase: 'specifying',
          id: 'q-2',
          origin: 'clarification',
          preview: 'Use JWT',
        },
        120,
      ),
    );

    expect(answered.map(rowText)).toEqual([
      'Answered  recorded — applied at the next planner call',
      'Use JWT',
    ]);
    expect(answered[0]?.markerTone).toBe('success');
  });

  it('marks a native injection and a drained queue as delivered in the success tone', () => {
    const native = rows(
      queueRowBlock(
        'queue',
        { type: 'message_injected_native', ts: 0, phase: 'planning', id: 'm-1', preview: 'hi' },
        120,
      ),
    );
    const drained = rows(
      queueRowBlock(
        'queue',
        {
          type: 'queue_drained',
          ts: 0,
          phase: 'implementing',
          seat: 'build',
          taskId: 'T003',
          count: 2,
          via: 'mid-call',
        },
        120,
      ),
    );

    expect(native.map(rowText)).toEqual(['Delivered to PLAN', 'hi']);
    expect(drained.map(rowText)).toEqual(['Delivered 2 messages mid-call to BUILD on T003']);
    for (const delivered of [native[0], drained[0]]) {
      expect(delivered?.markerTone).toBe('success');
      expect(delivered?.segments[0]?.tone).toBe('success');
    }
  });

  it('counts the removed messages of a cleared queue in a dim card', () => {
    const cleared = rows(
      queueRowBlock(
        'queue',
        { type: 'queue_cleared', ts: 0, phase: 'implementing', count: 3 },
        120,
      ),
    );

    expect(cleared.map(rowText)).toEqual(['Queue cleared  3 pending messages removed']);
    expect(cleared[0]?.segments.map((segment) => segment.tone)).toEqual(['textDim', 'textDim']);
  });
});
