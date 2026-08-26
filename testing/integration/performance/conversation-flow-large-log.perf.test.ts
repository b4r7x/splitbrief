import { describe, expect, it } from 'vitest';
import type { Section } from '../../../src/core/sections/event-sections.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { StreamingOutputState } from '../../../src/stores/workflow/streaming-output.js';
import type {
  ConversationRowInputs,
  ConversationRowsProjection,
} from '../../../src/features/workflow/conversation-rows/types.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
  resetConversationRowsProjectionCache,
} from '../../../src/features/workflow/conversation-rows/projection-cache.js';
import {
  markdownConversationRowsProjection,
  resetMarkdownConversationRowsCache,
} from '../../../src/features/workflow/conversation-rows/markdown-rows.js';
import { markdownLayoutGlyphs } from '../../../src/lib/glyphs.js';
import { parseMarkdownBlocks } from '../../../src/utils/markdown/block-parser.js';
import { layoutMarkdown } from '../../../src/utils/markdown/layout.js';
import type { MarkdownLayout } from '../../../src/utils/markdown/types.js';

const GLYPHS = markdownLayoutGlyphs();
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

function forceGc(): void {
  globalThis.gc?.();
}

// Cache-hit lookup loops finish in microseconds, where a single sample is at the mercy of GC and
// scheduler jitter; the ratio assertions compare the best of five samples instead.
function bestOfFiveMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let rep = 0; rep < 5; rep += 1) {
    forceGc();
    const startedAt = performance.now();
    run();
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

function cacheHitLoopMs(
  input: ConversationRowInputs,
  expected: ConversationRowsProjection,
): number {
  let hits = 0;
  const lookups = (): void => {
    for (let index = 0; index < 1_000; index += 1) {
      if (getConversationRowsProjection(input) === expected) hits += 1;
    }
  };
  lookups();
  const best = bestOfFiveMs(lookups);
  expect(hits).toBe(6_000);
  return best;
}

function conversationInput(sections: Section<EngineEvent>[]): ConversationRowInputs {
  return {
    sections,
    expandedDiffs: new Set<string>(),
    expandedActivityBatches: new Set<string>(),
    cols: 100,
    viewportHeight: 40,
    streaming,
  };
}

function fenceLines(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `const value${index} = ${index}; // note ${index}`,
  );
}

function fencedCode(language: string, lines: readonly string[]): string {
  return [`\`\`\`${language}`, ...lines, '```'].join('\n');
}

function highlightScopes(layout: MarkdownLayout): Set<string> {
  const scopes = new Set<string>();
  for (const row of layout.rows) {
    for (const line of row.lines) {
      for (const segment of line.segments) {
        if (segment.scope !== undefined) scopes.add(segment.scope);
      }
    }
  }
  return scopes;
}

describe.skipIf(process.env.SPLITBRIEF_PERF !== '1')('conversation row projection perf', () => {
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

    const first = markdownConversationRowsProjection(input);
    const appendAt = performance.now();
    const appended = markdownConversationRowsProjection({
      ...input,
      text: appendedText,
    });
    const appendMs = performance.now() - appendAt;

    resetMarkdownConversationRowsCache();
    const coldAppended = markdownConversationRowsProjection({
      ...input,
      text: appendedText,
    });

    expect(appended.rowCount).toBeGreaterThanOrEqual(first.rowCount);
    expect(coldAppended.rowCount).toBe(appended.rowCount);
    expect(appendMs).toBeLessThan(150);
  });

  it('serves repeated cache-hit lookups in time independent of transcript size', () => {
    resetConversationRowsProjectionCache();
    const smallInput = conversationInput(largeSections(1_000));
    const smallLookupMs = cacheHitLoopMs(smallInput, getConversationRowsProjection(smallInput));
    const largeInput = conversationInput(largeSections(10_000));
    const largeLookupMs = cacheHitLoopMs(largeInput, getConversationRowsProjection(largeInput));

    expect(largeLookupMs).toBeLessThanOrEqual(50);
    expect(largeLookupMs).toBeLessThanOrEqual(smallLookupMs * 2);
  });

  it('appends single events onto a 10k-event transcript with bounded per-append cost', () => {
    resetConversationRowsProjectionCache();
    let items: EngineEvent[] = Array.from({ length: 10_000 }, (_, index) => plannerText(index));
    const base = getConversationRowsProjection(conversationInput(eventSections(items)));
    forceGc();

    const durations: number[] = [];
    let latestTotalRows = base.totalRows;
    for (let index = 0; index < 50; index += 1) {
      items = [...items, plannerText(10_000 + index)];
      const input = conversationInput(eventSections(items));
      const startedAt = performance.now();
      const projection = getConversationRowsProjection(input);
      durations.push(performance.now() - startedAt);
      latestTotalRows = projection.totalRows;
    }
    const totalMs = durations.reduce((sum, ms) => sum + ms, 0);
    const sorted = [...durations].sort((a, b) => a - b);
    const p50Ms = sorted[25] ?? Number.POSITIVE_INFINITY;

    expect(latestTotalRows).toBeGreaterThan(base.totalRows);
    expect(p50Ms).toBeLessThanOrEqual(10);
    expect(totalMs).toBeLessThanOrEqual(750);
  });

  it('highlights a ts fence within the cold-layout budget and skips oversized fences', () => {
    const lines = fenceLines(100);
    const monoDocument = parseMarkdownBlocks(fencedCode('zzz', lines));
    const highlightedDocument = parseMarkdownBlocks(fencedCode('ts', lines));

    forceGc();
    const monoAt = performance.now();
    const mono = layoutMarkdown(monoDocument, { width: 96, glyphs: GLYPHS });
    const monoMs = performance.now() - monoAt;
    const highlightedAt = performance.now();
    const highlighted = layoutMarkdown(highlightedDocument, { width: 96, glyphs: GLYPHS });
    const highlightedMs = performance.now() - highlightedAt;

    const oversized = layoutMarkdown(parseMarkdownBlocks(fencedCode('ts', fenceLines(2_001))), {
      width: 96,
      glyphs: GLYPHS,
    });

    expect(highlightScopes(highlighted).size).toBeGreaterThanOrEqual(2);
    expect(highlightScopes(mono).size).toBe(0);
    expect(highlightScopes(oversized).size).toBe(0);
    expect(highlightedMs - monoMs).toBeLessThanOrEqual(50);
  });

  it('re-lays the streaming tail of a 500-line open fence within budget', () => {
    resetMarkdownConversationRowsCache();
    const openFence = [
      '```ts',
      ...Array.from({ length: 500 }, (_, index) => `const streamed${index} = ${index};`),
    ].join('\n');
    const input = {
      keyPrefix: 'markdown-open-fence',
      text: openFence,
      width: 96,
    };

    const first = markdownConversationRowsProjection(input);
    forceGc();
    const appendAt = performance.now();
    const appended = markdownConversationRowsProjection({
      ...input,
      text: `${openFence}\nconst appendedTail = 501;`,
    });
    const appendMs = performance.now() - appendAt;

    expect(appended.rowCount).toBeGreaterThan(first.rowCount);
    expect(appendMs).toBeLessThanOrEqual(150);
  });
});
