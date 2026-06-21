import { describe, expect, it } from 'vitest';
import type { Section } from '../../../src/core/sections/event-sections.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { StreamingOutputState } from '../../../src/stores/workflow/streaming-output.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
  resetConversationRowsProjectionCache,
} from '../../../src/features/workflow/conversation-rows/projection-cache.js';
import {
  markdownConversationRowsProjection,
  resetMarkdownConversationRowsCache,
} from '../../../src/features/workflow/conversation-rows/markdown-rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function plannerText(index: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: index,
    phase: 'planning',
    text: `large event ${index}`,
  };
}

function largeSections(count: number): Section<EngineEvent>[] {
  return [
    {
      type: 'events',
      startIndex: 0,
      items: Array.from({ length: count }, (_, index) => plannerText(index)),
    },
  ];
}

function markdownPlannerText(
  index: number,
  text: string,
): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: index,
    phase: 'planning',
    role: 'planner',
    content: 'markdown',
    text,
  };
}

function markdownListText(eventIndex: number, lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, lineIndex) =>
      `- T${String((lineIndex % 999) + 1).padStart(3, '0')} event ${eventIndex} update src/file-${lineIndex}.ts`,
  ).join('\n');
}

function eventSections(items: readonly EngineEvent[]): Section<EngineEvent>[] {
  return [{ type: 'events', startIndex: 0, items: [...items] }];
}

describe.skipIf(process.env.DIPTYCH_PERF !== '1')('conversation row projection perf', () => {
  it('projects and reuses a 10k event conversation log', () => {
    const input = {
      sections: largeSections(10_000),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 100,
      viewportHeight: 40,
      streaming,
    };

    const startedAt = performance.now();
    const first = getConversationRowsProjection(input);
    const firstMs = performance.now() - startedAt;
    const cachedAt = performance.now();
    const second = getConversationRowsProjection(input);
    const cachedMs = performance.now() - cachedAt;
    const windowAt = performance.now();
    const window = getConversationRowsWindowProjection({
      ...input,
      windowStart: Math.max(0, first.totalRows - 40),
      windowEnd: first.totalRows,
    });
    const windowMs = performance.now() - windowAt;

    expect(first.totalRows).toBeGreaterThan(10_000);
    expect(second).toBe(first);
    expect(window.rows.length).toBeLessThanOrEqual(40);
    expect(firstMs).toBeLessThan(1_500);
    expect(cachedMs).toBeLessThan(5);
    expect(windowMs).toBeLessThan(20);
  });

  it('projects latest markdown suffix append without cache-cap thrash', () => {
    resetConversationRowsProjectionCache();
    resetMarkdownConversationRowsCache();
    const markdownEvents = Array.from({ length: 30 }, (_, index) =>
      markdownPlannerText(index, markdownListText(index, 500)),
    );
    const input = {
      sections: eventSections(markdownEvents),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 96,
      viewportHeight: 40,
      streaming,
    };

    const startedAt = performance.now();
    const cold = getConversationRowsProjection(input);
    const coldMs = performance.now() - startedAt;
    const appendedEvents = markdownEvents.map((event, index) =>
      index === markdownEvents.length - 1
        ? {
            ...event,
            ts: event.ts + 10_000,
            text: `${event.text}\n- T001 appended latest suffix in src/appended.ts`,
          }
        : event,
    );
    const appendAt = performance.now();
    const appended = getConversationRowsProjection({
      ...input,
      sections: eventSections(appendedEvents),
    });
    const appendMs = performance.now() - appendAt;

    expect(appended.totalRows).toBeGreaterThan(cold.totalRows);
    expect(appendMs).toBeLessThan(coldMs * 0.55);
  });

  it('projects markdown suffix appends without full-history parse/layout work', () => {
    resetMarkdownConversationRowsCache();
    const baseText = Array.from(
      { length: 5_000 },
      (_, index) => `- T${String((index % 999) + 1).padStart(3, '0')} update src/file-${index}.ts`,
    ).join('\n');
    const input = {
      keyPrefix: 'markdown-stream',
      text: baseText,
      width: 96,
    };

    const startedAt = performance.now();
    const first = markdownConversationRowsProjection(input);
    const firstMs = performance.now() - startedAt;
    const cachedAt = performance.now();
    const cached = markdownConversationRowsProjection(input);
    const cachedMs = performance.now() - cachedAt;
    const appendAt = performance.now();
    const appended = markdownConversationRowsProjection({
      ...input,
      text: `${baseText}\n- T001 update src/appended.ts`,
    });
    const appendMs = performance.now() - appendAt;

    expect(cached).toBe(first);
    expect(appended.rowCount).toBeGreaterThan(first.rowCount);
    expect(cachedMs).toBeLessThan(25);
    expect(appendMs).toBeLessThan(firstMs / 4);
    expect(appendMs).toBeLessThan(150);
  });

  it('projects single-paragraph markdown suffix appends with bounded whole-paragraph layout', () => {
    resetMarkdownConversationRowsCache();
    const baseText = Array.from({ length: 5_000 }, (_, index) => `paragraph-token-${index}`).join(
      ' ',
    );
    const appendedText = `${baseText} paragraph-token-appended`;
    const input = {
      keyPrefix: 'markdown-paragraph-stream',
      text: baseText,
      width: 96,
    };

    const startedAt = performance.now();
    const first = markdownConversationRowsProjection(input);
    const firstMs = performance.now() - startedAt;
    const appendAt = performance.now();
    const appended = markdownConversationRowsProjection({
      ...input,
      text: appendedText,
    });
    const appendMs = performance.now() - appendAt;

    resetMarkdownConversationRowsCache();
    const coldAppendAt = performance.now();
    const coldAppended = markdownConversationRowsProjection({
      ...input,
      text: appendedText,
    });
    const coldAppendMs = performance.now() - coldAppendAt;

    expect(appended.rowCount).toBeGreaterThanOrEqual(first.rowCount);
    expect(coldAppended.rowCount).toBe(appended.rowCount);
    expect(appendMs).toBeLessThan(Math.max(150, coldAppendMs * 2));
    expect(appendMs).toBeLessThan(Math.max(150, firstMs * 2));
    expect(appendMs).toBeLessThan(150);
  });
});
