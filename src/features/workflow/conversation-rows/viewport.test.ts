import { describe, expect, it } from 'vitest';
import type { Section } from '../../../core/sections/types.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import type { WorkflowTask } from '../../../core/run-view/briefs.js';
import { rowText } from './row-format/rows.js';
import { computeConversationRowScroll } from './scroll.js';
import { conversationViewportWindow, splitConversationViewport } from './viewport.js';

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
          id: `T${String(index + 1).padStart(3, '0')}`,
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
    expect(split.transcriptViewportHeight).toBe(15);
  });

  it('charges each bookend its own header and blank, so the split always reconciles', () => {
    for (const viewportHeight of [8, 10, 12, 20, 30, 40, 60]) {
      const split = splitConversationViewport({
        viewportHeight,
        sections: sections(17, 25),
        pendingTaskCount: 22,
      });
      const painted =
        split.transcriptViewportHeight + (split.queuedRows > 0 ? split.queuedRows + 2 : 0);

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
    expect(split.transcriptViewportHeight).toBe(scroll.viewportHeight);
    expect(scroll.scrollOffset).toBe(scroll.maxOffset);
  });
});

describe('conversationViewportWindow', () => {
  const liveSections: Section<EngineEvent>[] = [
    {
      type: 'events',
      items: Array.from({ length: 30 }, (_, index) => plannerText(index)),
      startIndex: 0,
    },
  ];

  function pending(count: number): WorkflowTask[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `T00${index + 1}`,
      title: `brief ${index + 1}`,
      status: 'pending' as const,
    }));
  }

  function viewportWindow(input: {
    height: number;
    sections?: Section<EngineEvent>[];
    pendingTasks?: WorkflowTask[];
    rawScrollOffset?: number;
    renderableCountAtScroll?: number;
    heightAtScroll?: number;
  }) {
    return conversationViewportWindow({
      height: input.height,
      pendingTasks: input.pendingTasks ?? [],
      isRunning: false,
      sections: input.sections ?? liveSections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 80,
      rawScrollOffset: input.rawScrollOffset ?? 0,
      renderableCountAtScroll: input.renderableCountAtScroll ?? 0,
      heightAtScroll: input.heightAtScroll ?? 0,
      streaming,
      tail: undefined,
    });
  }

  it.each([
    [20, 2, 2, ['T001 brief 1', 'T002 brief 2'], 0],
    [6, 4, 1, ['T001 brief 1'], 3],
    [20, 5, 3, ['T001 brief 1', 'T002 brief 2'], 3],
  ] as const)(
    'at %i rows with %i pending briefs gives the block %i rows',
    (height, count, rows, shown, hidden) => {
      const view = viewportWindow({ height, pendingTasks: pending(count) });

      expect(view.queued.rows).toBe(rows);
      expect(view.queued.shown.map(rowText)).toEqual(shown);
      expect(view.queued.hidden).toBe(hidden);
    },
  );

  it('ends the transcript window on the last row when the user did not scroll', () => {
    const view = viewportWindow({ height: 10 });

    expect(view.rows.map(rowText).at(-1)).toBe('event 29');
    expect(view.rows).toHaveLength(10);
    expect(view.transcriptHeight).toBe(10);
    expect(view.above).toBe('49 lines above');
    expect(view.below).toBe('');
  });

  it('names the rows below and the new events when the user scrolled up', () => {
    const view = viewportWindow({
      height: 10,
      rawScrollOffset: 3,
      renderableCountAtScroll: 28,
      heightAtScroll: 59,
    });

    expect(view.rows.map(rowText).at(0)).toBe('event 23');
    expect(view.above).toBe('46 lines above');
    expect(view.below).toBe('3 lines below · ↓ 2 new events');
  });

  it('keeps one row for the empty state of a run with no events', () => {
    const view = viewportWindow({ height: 10, sections: [] });

    expect(view.rows).toEqual([]);
    expect(view.showsEmptyState).toBe(true);
    expect(view.transcriptHeight).toBe(1);
  });
});
