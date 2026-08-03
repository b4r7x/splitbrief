import { beforeEach, describe, expect, it } from 'vitest';
import type { Section } from '../../../core/sections/event-sections.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
  resetConversationRowsProjectionCache,
} from './projection-cache.js';
import { rowText } from './row-format/rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function plannerText(index: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: index,
    phase: 'planning',
    text: `event ${index}`,
  };
}

function sections(count: number): Section<EngineEvent>[] {
  return [
    {
      type: 'events',
      startIndex: 0,
      items: Array.from({ length: count }, (_, index) => plannerText(index)),
    },
  ];
}

function runningEvent(): Extract<EngineEvent, { type: 'implementer_generate_running' }> {
  return {
    type: 'implementer_generate_running',
    ts: 1,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'src/app.ts',
  };
}

function activityEvent(
  overrides?: Partial<Extract<EngineEvent, { type: 'runner_call_activity' }>>,
): Extract<EngineEvent, { type: 'runner_call_activity' }> {
  return {
    type: 'runner_call_activity',
    ts: 1_000,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'xhigh',
    attempt: 0,
    sequence: 1,
    activityId: 'activity-1',
    stage: 'completed',
    kind: 'command',
    label: 'ran command',
    target: 'npm test',
    redacted: false,
    ...overrides,
  };
}

function eventSections(items: EngineEvent[]): Section<EngineEvent>[] {
  return [{ type: 'events', startIndex: 0, items }];
}

describe('conversation rows projection cache', () => {
  beforeEach(() => {
    resetConversationRowsProjectionCache();
  });

  it('returns the identical projection object for identical input identities', () => {
    const input = {
      sections: sections(3),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
    };

    const first = getConversationRowsProjection(input);
    const second = getConversationRowsProjection(input);

    expect(second).toBe(first);
  });

  it('invalidates cached rows when width or expansion state changes', () => {
    const base = {
      sections: sections(3),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
    };

    const first = getConversationRowsProjection(base);
    const widthChanged = getConversationRowsProjection({ ...base, cols: 60 });
    const expansionChanged = getConversationRowsProjection({
      ...base,
      expandedDiffs: new Set(['implementer_generate_done:1']),
    });

    expect(widthChanged).not.toBe(first);
    expect(expansionChanged).not.toBe(widthChanged);
  });

  it('rebuilds when a set input is a new identity with equal contents', () => {
    const base = {
      sections: sections(3),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
    };

    const first = getConversationRowsProjection(base);
    const second = getConversationRowsProjection({ ...base, expandedDiffs: new Set<string>() });

    expect(second).not.toBe(first);
    expect(second.totalRows).toBe(first.totalRows);
  });

  it('rebuilds after resetConversationRowsProjectionCache', () => {
    const input = {
      sections: sections(3),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
    };

    const first = getConversationRowsProjection(input);
    resetConversationRowsProjectionCache();
    const second = getConversationRowsProjection(input);

    expect(second).not.toBe(first);
    expect(second.totalRows).toBe(first.totalRows);
  });

  it('rebuilds when an event object is replaced as mergeEvent does', () => {
    const event = plannerText(1);
    const base = {
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
      windowStart: 0,
      windowEnd: 1,
    };

    const first = getConversationRowsWindowProjection({
      ...base,
      sections: eventSections([event]),
    });
    const second = getConversationRowsWindowProjection({
      ...base,
      sections: eventSections([{ ...event, text: 'merged event text' }]),
    });

    expect(first.rows.map(rowText)).toEqual(['event 1']);
    expect(second.rows.map(rowText)).toEqual(['merged event text']);
  });

  it('materializes only the requested visible row window from the cached projection', () => {
    const projection = getConversationRowsWindowProjection({
      sections: sections(6),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
      windowStart: 2,
      windowEnd: 5,
    });

    // Six single-line events with a one-row spacer between each: 6 + 5×1 = 11 rows.
    expect(projection.totalRows).toBe(11);
    // Window [2,5) straddles event 1, the spacer after it, then event 2.
    expect(projection.rows.map(rowText)).toEqual(['event 1', '', 'event 2']);
    expect(projection.windowStart).toBe(2);
    expect(projection.windowEnd).toBe(5);
  });

  it('invalidates when streaming lines are replaced with the same count and last line', () => {
    const base = {
      sections: eventSections([runningEvent()]),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming: {
        active: true,
        taskId: taskId('T001'),
        lines: ['first visible line', 'same tail'],
      },
      windowStart: 0,
      windowEnd: 5,
    };

    const first = getConversationRowsWindowProjection(base);
    const second = getConversationRowsWindowProjection({
      ...base,
      streaming: {
        active: true,
        taskId: taskId('T001'),
        lines: ['changed visible line', 'same tail'],
      },
    });

    expect(first.rows.map(rowText).join('\n')).toContain('first visible line');
    expect(second.rows.map(rowText).join('\n')).toContain('changed visible line');
  });

  it('invalidates when planner phase changes for markdown content with the same text', () => {
    const base = {
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
      windowStart: 0,
      windowEnd: 5,
    };
    const planning = getConversationRowsWindowProjection({
      ...base,
      sections: eventSections([
        {
          type: 'planner_text',
          ts: 1,
          phase: 'planning',
          text: '### Heading',
          role: 'planner',
          content: 'markdown',
        },
      ]),
    });
    const researching = getConversationRowsWindowProjection({
      ...base,
      sections: eventSections([
        {
          type: 'planner_text',
          ts: 1,
          phase: 'researching',
          text: '### Heading',
          role: 'planner',
          content: 'markdown',
        },
      ]),
    });

    expect(planning.rows.map(rowText)).toEqual(['Plan', 'Heading']);
    expect(researching.rows.map(rowText)).toEqual(['Research', 'Heading']);
  });

  it('invalidates when planner text content mode or role changes', () => {
    const plain = getConversationRowsWindowProjection({
      sections: eventSections([
        { type: 'planner_text', ts: 1, phase: 'planning', text: '### Heading', role: 'planner' },
      ]),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
      windowStart: 0,
      windowEnd: 5,
    });
    const markdown = getConversationRowsWindowProjection({
      sections: eventSections([
        {
          type: 'planner_text',
          ts: 1,
          phase: 'planning',
          text: '### Heading',
          role: 'planner',
          content: 'markdown',
        },
      ]),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 10,
      streaming,
      windowStart: 0,
      windowEnd: 5,
    });

    expect(plain.rows.map(rowText)).toEqual(['### Heading']);
    expect(markdown.rows.map(rowText)).toEqual(['Plan', 'Heading']);
  });

  it('invalidates when activity role or runner metadata changes', () => {
    const base = {
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 120,
      viewportHeight: 10,
      streaming,
      windowStart: 0,
      windowEnd: 5,
    };
    const implementer = getConversationRowsWindowProjection({
      ...base,
      sections: eventSections([
        activityEvent({ sequence: 1, activityId: 'activity-1', label: 'started command' }),
        activityEvent({
          sequence: 2,
          activityId: 'activity-2',
          label: 'finished command',
          target: 'npm run build',
        }),
      ]),
    });
    const planner = getConversationRowsWindowProjection({
      ...base,
      sections: eventSections([
        activityEvent({
          sequence: 1,
          activityId: 'activity-1',
          role: 'planner',
          runnerName: 'claude-code',
          model: 'sonnet',
          label: 'started command',
        }),
        activityEvent({
          sequence: 2,
          activityId: 'activity-2',
          role: 'planner',
          runnerName: 'claude-code',
          model: 'sonnet',
          label: 'finished command',
          target: 'npm run build',
        }),
      ]),
    });

    expect(implementer.rows.map(rowText).join('\n')).toContain('Implementer activity');
    expect(implementer.rows.map(rowText).join('\n')).toContain('[OpenAI Codex CLI · xhigh]');
    expect(planner.rows.map(rowText).join('\n')).toContain('Plan activity');
    expect(planner.rows.map(rowText).join('\n')).toContain('[Claude Code CLI · sonnet]');
  });
});
