import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../../testing/helpers/ink.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { Section } from '../../../../core/layout/event-sections.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { ConversationFlow } from './flow.js';

function makePlannerText(index: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: index,
    phase: 'planning',
    text: `event ${index}`,
  };
}

function makePlannerTextBlock(lines: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: 0,
    phase: 'planning',
    text: Array.from({ length: lines }, (_, index) => `line-${index + 1}`).join('\n'),
  };
}

function makeLongTaskStarted(): Extract<EngineEvent, { type: 'task_started' }> {
  return {
    type: 'task_started',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'No-op workflow demonstration with enough metadata to wrap',
    index: 0,
    total: 1,
    file: 'README.md',
    action: 'modify',
    tool: 'claude-code',
    model: 'sonnet',
    implementerProfile: 'default',
    contextFit: 'fits',
    estimatedTokens: 3911,
    contextLength: 32768,
    currentCodeContextMode: 'whole-file',
    costPosture: 'Selected unknown cost tier via cheapest-capable routing',
  };
}

function makeRunningImplementer(): Extract<EngineEvent, { type: 'implementer_generate_running' }> {
  return {
    type: 'implementer_generate_running',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'README.md',
  };
}

function frameRowCount(frame: string): number {
  return frame.length === 0 ? 0 : frame.split('\n').length;
}

function normalizedRows(frame: string): string[] {
  return windowRows(frame)
    .filter(line => line !== '');
}

function windowRows(frame: string): string[] {
  return frame
    .split('\n')
    .map(line => line.replace(/[│┆]/g, '').trim())
    .filter(line =>
      !line.includes('line above') &&
      !line.includes('lines above') &&
      !line.includes('line below') &&
      !line.includes('lines below') &&
      !line.includes('new event')
    );
}

function contentRows(frame: string): string[] {
  return normalizedRows(frame)
    .filter(line => /^line-\d+$/.test(line));
}

describe('ConversationFlow', () => {
  beforeEach(() => {
    conversationScrollStore.reset();
    streamingOutputStore.__testReset();
  });

  it('keeps scroll indicators inside the fixed viewport', () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));
    const sections: Section<EngineEvent>[] = [{ type: 'events', startIndex: 0, items: events }];

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: events.length,
      heightAtScroll: 11,
    });

    const ui = renderFeature(<ConversationFlow sections={sections} height={10} width={80} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2 lines above');
    expect(frame).toContain('1 line below');
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });

  it('shows new renderable events without growing the viewport when scrolled up', () => {
    const events = Array.from({ length: 7 }, (_, index) => makePlannerText(index));
    const sections: Section<EngineEvent>[] = [{ type: 'events', startIndex: 0, items: events }];

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 6,
      heightAtScroll: 11,
    });

    const ui = renderFeature(<ConversationFlow sections={sections} height={10} width={80} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('↓ 1 new event');
    expect(frame).toContain('3 lines below');
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });


  it('moves a tall event by one rendered row between adjacent scroll offsets', () => {
    const sections: Section<EngineEvent>[] = [{
      type: 'events',
      startIndex: 0,
      items: [makePlannerTextBlock(12)],
    }];

    conversationScrollStore.__testReset({
      scrollOffset: 0,
      renderableCountAtScroll: 1,
      heightAtScroll: 12,
    });
    const bottom = renderFeature(<ConversationFlow sections={sections} height={6} width={80} />);
    const bottomFrame = bottom.lastFrame() ?? '';
    bottom.unmount();

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 12,
    });
    const scrolled = renderFeature(<ConversationFlow sections={sections} height={6} width={80} />);
    const scrolledFrame = scrolled.lastFrame() ?? '';

    expect(contentRows(bottomFrame)).toEqual(['line-9', 'line-10', 'line-11', 'line-12']);
    expect(contentRows(scrolledFrame)).toEqual(['line-8', 'line-9', 'line-10', 'line-11']);
    expect(scrolledFrame).toContain('1 line below');
    expect(frameRowCount(scrolledFrame)).toBeLessThanOrEqual(6);

    scrolled.unmount();
  });

  it('scrolls a wrapped task_started card by rendered rows, not by the whole card', () => {
    const sections: Section<EngineEvent>[] = [{
      type: 'events',
      startIndex: 0,
      items: [makeLongTaskStarted(), makePlannerTextBlock(8)],
    }];

    conversationScrollStore.__testReset({
      scrollOffset: 4,
      renderableCountAtScroll: 2,
      heightAtScroll: 13,
    });
    const bottom = renderFeature(<ConversationFlow sections={sections} height={7} width={72} />);
    const bottomRows = windowRows(bottom.lastFrame() ?? '');
    bottom.unmount();

    conversationScrollStore.__testReset({
      scrollOffset: 5,
      renderableCountAtScroll: 2,
      heightAtScroll: 13,
    });
    const scrolled = renderFeature(<ConversationFlow sections={sections} height={7} width={72} />);
    const scrolledFrame = scrolled.lastFrame() ?? '';
    const scrolledRows = windowRows(scrolledFrame);

    expect(scrolledRows.slice(1)).toEqual(bottomRows.slice(0, -1));
    expect(scrolledFrame).toContain('5 lines below');
    expect(frameRowCount(scrolledFrame)).toBeLessThanOrEqual(7);

    scrolled.unmount();
  });

  it('includes streaming output in row height and scrolls it one rendered row at a time', () => {
    const sections: Section<EngineEvent>[] = [{
      type: 'events',
      startIndex: 0,
      items: [makeRunningImplementer()],
    }];
    streamingOutputStore.__testReset({
      active: true,
      taskId: taskId('T001'),
      lines: ['stream-1', 'stream-2', 'stream-3', 'stream-4', 'stream-5', 'stream-6'],
    });

    conversationScrollStore.__testReset({
      scrollOffset: 0,
      renderableCountAtScroll: 1,
      heightAtScroll: 6,
    });
    const bottom = renderFeature(<ConversationFlow sections={sections} height={5} width={80} />);
    const bottomRows = normalizedRows(bottom.lastFrame() ?? '');
    bottom.unmount();

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 6,
    });
    const scrolled = renderFeature(<ConversationFlow sections={sections} height={5} width={80} />);
    const scrolledFrame = scrolled.lastFrame() ?? '';
    const scrolledRows = normalizedRows(scrolledFrame);

    expect(bottomRows).toEqual(['stream-3', 'stream-4', 'stream-5']);
    expect(scrolledRows).toEqual(['stream-2', 'stream-3', 'stream-4']);
    expect(scrolledFrame).toContain('1 line below');
    expect(frameRowCount(scrolledFrame)).toBeLessThanOrEqual(5);

    scrolled.unmount();
  });

  it('does not let completed task summaries expand the fixed viewport', () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));
    const sections: Section<EngineEvent>[] = [
      {
        type: 'completed-task',
        summary: { index: 1, title: 'Finished task', method: 'local', retries: 0, duration: 1 },
      },
      { type: 'events', startIndex: 0, items: events },
    ];

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: events.length,
      heightAtScroll: 11,
    });

    const ui = renderFeature(<ConversationFlow sections={sections} height={10} width={80} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Finished task');
    expect(frame).toContain('3 lines above');
    expect(frame).toContain('1 line below');
    expect(normalizedRows(frame).filter(line => line.startsWith('event '))).toEqual(['event 2', 'event 3', 'event 4']);
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });
});
