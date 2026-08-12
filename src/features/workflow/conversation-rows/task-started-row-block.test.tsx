import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import { glyph } from '../../../lib/glyphs.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { renderFeature } from '#testing/helpers/ink.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { ConversationRowView } from '../components/conversation-flow/row-view.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };
const LIVE_MARK = glyph('statusInProgress');
const DONE_MARK = glyph('statusDone');

describe('taskStartedRowBlock markers', () => {
  it('a wrapped task_started block renders the status marker on its first line only', () => {
    const rows = eventRows({
      event: makeTaskStart({
        ts: 0,
        taskId: taskId('T001'),
        title: 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet',
        total: 1,
        file: 'z.ts',
        action: 'modify',
        tool: 'codex',
        implementerProfile: 'cheap',
        contextFit: 'fits',
        estimatedTokens: 100,
        contextLength: 32_768,
        routingReason: 'cheap',
      }),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 22, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.headerContinuation).not.toBe(true);
    for (const row of rows.slice(1)) {
      expect(row.headerContinuation).toBe(true);
      expect(row.kind).toBe('task-header');
    }

    const first = renderFeature(<ConversationRowView row={rows[0]!} lifecycle="live" />);
    expect(first.lastFrame() ?? '').toContain(LIVE_MARK);
    first.unmount();

    for (const row of rows.slice(1)) {
      const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain(LIVE_MARK);
      expect(frame).not.toContain(DONE_MARK);
      ui.unmount();
    }
  });
});

describe('taskStartedRowBlock continuations', () => {
  it('never starts a continuation with the break whitespace or a separator', () => {
    const rows = eventRows({
      event: makeTaskStart({
        taskId: taskId('T002'),
        index: 1,
        total: 4,
        title: 'Infer capabilities from the cloud model list',
        file: 'src/engine/providers/capability-inference.ts',
        action: 'modify',
        tool: 'claude-code',
        model: 'sonnet',
      }),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 60, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) {
      const text = row.segments.map((segment) => segment.text).join('');
      expect(text).not.toMatch(/^\s/);
      expect(text).not.toMatch(/^·/);
    }
  });
});
