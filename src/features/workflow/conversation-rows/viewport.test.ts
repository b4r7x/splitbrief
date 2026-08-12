import { describe, expect, it } from 'vitest';
import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { computeConversationRowScroll } from './scroll.js';
import { splitConversationViewport } from './viewport.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function plannerText(index: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: index,
    phase: 'planning',
    text: `event ${index}`,
  };
}

describe('splitConversationViewport', () => {
  it('gives the whole viewport to the transcript when there is no chrome to reserve', () => {
    const split = splitConversationViewport({
      viewportHeight: 10,
      sections: [],
      pendingTaskCount: 0,
    });
    expect(split.transcriptViewportHeight).toBe(10);
    expect(split.queuedRows).toBe(0);
    expect(split.completedRows).toBe(0);
  });
});

describe('splitConversationViewport — bookend budget', () => {
  function sections(completed: number, live: number): Section<EngineEvent>[] {
    return [
      ...Array.from({ length: completed }, (_, index) => ({
        type: 'completed-task' as const,
        items: [],
        startIndex: index,
        summary: {
          index,
          title: `completed ${index}`,
          method: 'local' as const,
          retries: 0,
          duration: 1,
        },
      })),
      ...(live > 0
        ? [
            {
              type: 'events',
              items: Array.from({ length: live }, (_, index) => plannerText(index)),
              startIndex: completed,
            } satisfies Section<EngineEvent>,
          ]
        : []),
    ];
  }

  it('stops the queue from eating the viewport when the plan is long', () => {
    // The defect: a 40-task plan at a 20-row viewport gave the queue 16 of 20 rows and left the
    // completed summary with none, on the one surface a narrow terminal has.
    const split = splitConversationViewport({
      viewportHeight: 20,
      sections: sections(17, 25),
      pendingTaskCount: 22,
    });

    expect(split.queuedRows).toBe(3);
    expect(split.completedRows).toBe(3);
    expect(split.transcriptViewportHeight).toBe(10);
  });

  it('charges each bookend its own header and blank, so the split always reconciles', () => {
    for (const viewportHeight of [8, 10, 12, 20, 30, 40, 60]) {
      const split = splitConversationViewport({
        viewportHeight,
        sections: sections(17, 25),
        pendingTaskCount: 22,
      });
      const painted =
        split.transcriptViewportHeight +
        (split.completedRows > 0 ? split.completedRows + 2 : 0) +
        (split.queuedRows > 0 ? split.queuedRows + 2 : 0);

      expect(painted, `viewport ${viewportHeight}`).toBe(viewportHeight);
    }
  });

  it('gives extra height to the transcript rather than to the bookends', () => {
    const at20 = splitConversationViewport({
      viewportHeight: 20,
      sections: sections(17, 25),
      pendingTaskCount: 22,
    });
    const at60 = splitConversationViewport({
      viewportHeight: 60,
      sections: sections(17, 25),
      pendingTaskCount: 22,
    });

    expect(at60.completedRows).toBe(at20.completedRows);
    expect(at60.queuedRows).toBe(at20.queuedRows);
    expect(at60.transcriptViewportHeight - at20.transcriptViewportHeight).toBe(40);
  });

  it('keeps completed/live/queued paint and pointer/keyboard geometry on one split', () => {
    const split = splitConversationViewport({
      viewportHeight: 20,
      sections: sections(17, 25),
      pendingTaskCount: 22,
    });
    const scroll = computeConversationRowScroll({
      sections: sections(17, 25),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 80,
      viewportHeight: split.transcriptViewportHeight,
      rawScrollOffset: Number.POSITIVE_INFINITY,
      renderableCountAtScroll: 0,
      heightAtScroll: 0,
      streaming,
    });
    const painted =
      split.transcriptViewportHeight +
      (split.completedRows > 0 ? split.completedRows + 2 : 0) +
      (split.queuedRows > 0 ? split.queuedRows + 2 : 0);

    expect(painted).toBe(20);
    expect(split.transcriptViewportHeight).toBe(scroll.viewportHeight);
    expect(scroll.maxOffset).toBe(scroll.totalDynamicHeight - scroll.viewportHeight);
    expect(scroll.scrollOffset).toBe(scroll.maxOffset);
    expect(split.stickyLeadingRows).toBe(split.completedRows + 2);
    expect(scroll.rows[2]).toBeDefined();
  });
});
