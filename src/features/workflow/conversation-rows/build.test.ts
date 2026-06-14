import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { Section } from '../../../core/sections/event-sections.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { diffEventKey } from '../../../core/sections/event-sections.js';
import { buildConversationRows } from './build.js';
import { rowText } from './row-format.js';
import type { ConversationRowInputs } from './types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function eventsSection(items: EngineEvent[]): Section<EngineEvent> {
  return { type: 'events', items, startIndex: 0 };
}

function inputsFor(
  sections: Section<EngineEvent>[],
  overrides: Partial<ConversationRowInputs> = {},
): ConversationRowInputs {
  return {
    sections,
    expandedDiffs: new Set<string>(),
    cols: 40,
    viewportHeight: 20,
    streaming,
    ...overrides,
  };
}

describe('buildConversationRows caching', () => {
  it('reuses the wrapped rows for a stable event across rebuilds at the same width', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      text: 'a fairly long line of planner output that needs wrapping at the configured width',
    };
    const section = eventsSection([event]);

    const first = buildConversationRows(inputsFor([section]));
    const second = buildConversationRows(inputsFor([section]));

    expect(first.rows.map(rowText)).toEqual(second.rows.map(rowText));
    expect(second.rows.every((row, i) => row === first.rows[i])).toBe(true);
  });

  it('rewraps a stable event when the width changes', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      text: 'a fairly long line of planner output that needs wrapping at the configured width',
    };
    const section = eventsSection([event]);

    const wide = buildConversationRows(inputsFor([section], { cols: 80 }));
    const narrow = buildConversationRows(inputsFor([section], { cols: 20 }));

    expect(narrow.rows.length).toBeGreaterThan(wide.rows.length);
  });

  it('rebuilds a streaming implementer event so fresh stream lines are reflected', () => {
    const event: EngineEvent = {
      type: 'implementer_generate_running',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      file: 'a.ts',
    };
    const section = eventsSection([event]);

    const before = buildConversationRows(
      inputsFor([section], {
        streaming: { taskId: taskId('T001'), lines: ['old line'], active: true },
      }),
    );
    const after = buildConversationRows(
      inputsFor([section], {
        streaming: { taskId: taskId('T001'), lines: ['new line'], active: true },
      }),
    );

    expect(before.rows.map(rowText).join('\n')).toContain('old line');
    expect(after.rows.map(rowText).join('\n')).toContain('new line');
    expect(after.rows.map(rowText).join('\n')).not.toContain('old line');
  });
});

describe('buildConversationRows expanded-diff keying', () => {
  const diffEvent: EngineEvent = {
    type: 'implementer_generate_done',
    ts: 7777,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'src/a.ts',
    diff: '+ added line\n- removed line',
    linesAdded: 1,
    linesRemoved: 1,
    duration: 100,
  };

  it('renders the diff expanded only when its stable key is in expandedDiffs', () => {
    const section = eventsSection([diffEvent]);

    const collapsed = buildConversationRows(inputsFor([section]));
    const expanded = buildConversationRows(
      inputsFor([section], { expandedDiffs: new Set([diffEventKey(diffEvent)]) }),
    );

    expect(collapsed.rows.map(rowText).join('\n')).toContain('▸');
    expect(collapsed.rows.map(rowText).join('\n')).not.toContain('added line');
    expect(expanded.rows.map(rowText).join('\n')).toContain('▾');
    expect(expanded.rows.map(rowText).join('\n')).toContain('added line');
  });

  it('keeps a diff expanded after its array position shifts (sliding-window drop)', () => {
    const expandedDiffs = new Set([diffEventKey(diffEvent)]);

    const atIndexZero = eventsSection([diffEvent]);
    const shifted: Section<EngineEvent> = {
      type: 'events',
      startIndex: 9999,
      items: [{ type: 'planner_text', ts: 1, phase: 'planning', text: 'noise' }, diffEvent],
    };

    const before = buildConversationRows(inputsFor([atIndexZero], { expandedDiffs }));
    const after = buildConversationRows(inputsFor([shifted], { expandedDiffs }));

    expect(before.rows.map(rowText).join('\n')).toContain('added line');
    expect(after.rows.map(rowText).join('\n')).toContain('added line');
  });
});
