import { describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { ConversationFlow } from '../../../src/features/workflow/components/conversation-flow/flow.js';
import { conversationScrollStore } from '../../../src/stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { streamingOutputStore } from '../../../src/stores/workflow/streaming-output.js';
import { tasksStore } from '../../../src/stores/workflow/tasks.js';
import { hoverStore } from '../../../src/stores/ui/hover.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { resetConversationRowsProjectionCache } from '../../../src/features/workflow/conversation-rows/projection-cache.js';

const FOCUS_MARK = glyph('liveBar');

function forceGc(): void {
  globalThis.gc?.();
}

function largeConversation(eventCount: number): EngineEvent[] {
  return Array.from({ length: eventCount }, (_, index) =>
    makePlannerText({ ts: index, phase: 'planning', text: `large hover event ${index}` }),
  );
}

function countGlyphOccurrences(frame: string, mark: string): number {
  if (mark.length === 0) return 0;
  let count = 0;
  let index = frame.indexOf(mark);
  while (index !== -1) {
    count += 1;
    index = frame.indexOf(mark, index + mark.length);
  }
  return count;
}

describe.skipIf(process.env.SPLITBRIEF_PERF !== '1')('conversation flow hover perf', () => {
  it('updates hover focus with bounded cost on a large transcript', async () => {
    resetConversationRowsProjectionCache();
    eventsStore.__testReset();
    conversationScrollStore.reset();
    streamingOutputStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    hoverStore.clear();

    const events = largeConversation(4_000);
    eventsStore.__testReset({ events });

    const ui = renderFeature(
      <ConversationFlow height={24} conversationWidth={96} contentWidth={96} />,
    );
    await tick(30);

    const baseline = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(baseline).not.toContain(FOCUS_MARK);

    const durations: number[] = [];
    for (let index = 0; index < 80; index += 1) {
      const startedAt = performance.now();
      hoverStore.set('conversation', 2 + (index % 12));
      await tick(5);
      durations.push(performance.now() - startedAt);
    }

    forceGc();
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThanOrEqual(40);

    const focused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(countGlyphOccurrences(focused, FOCUS_MARK)).toBeLessThanOrEqual(1);
    for (const token of ['line-1', 'line-8', 'large hover event 0']) {
      expect(focused).toContain(token);
      expect(baseline).toContain(token);
    }

    hoverStore.clear();
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toBe(baseline);

    ui.unmount();
  });
});
