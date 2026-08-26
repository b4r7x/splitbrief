import { describe, it, expect } from 'vitest';
import {
  groupEventsIntoSections,
  findLatestRenderableDiffKey,
  diffEventKey,
} from './event-sections.js';
import type { Section } from './event-sections.js';
import { taskId } from '../schemas/task.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';
import { makeTaskStart, makeTaskComplete, makeTaskSkipped } from '#testing/helpers/events/task.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';

function requireSection<T extends Section['type']>(
  sections: Section[],
  idx: number,
  type: T,
): Extract<Section, { type: T }> {
  const section = sections[idx];
  if (!section) throw new Error(`Expected section at index ${idx}, got undefined`);
  if (section.type !== type)
    throw new Error(`Expected section[${idx}].type === '${type}', got '${section.type}'`);
  return section as Extract<Section, { type: T }>;
}

describe('groupEventsIntoSections', () => {
  it('returns empty array for empty events', () => {
    expect(groupEventsIntoSections([])).toEqual([]);
  });

  it('wraps non-task events in events section', () => {
    const events = [makePlannerText(), makePlannerText()];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    expect(requireSection(sections, 0, 'events').items).toHaveLength(2);
  });

  it('creates completed-task section for task-start + task-complete pair', () => {
    const generateEvent = makeImplementerGenerate();
    const events = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Auth', index: 0 }),
      generateEvent,
      makeTaskComplete({ taskId: taskId('T001'), method: 'local', retries: 1, duration: 8000 }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    const section = requireSection(sections, 0, 'completed-task');
    const summary = section.summary;
    expect(summary.index).toBe(1);
    expect(summary.title).toBe('Auth');
    expect(summary.method).toBe('local');
    expect(summary.retries).toBe(1);
    expect(summary.duration).toBe(8000);
    expect(section.items).toEqual(events);
    expect(section.items).toContain(generateEvent);
    expect(section.startIndex).toBe(0);
  });

  it('creates completed-task section for task-start + task-skipped pair', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T002'), title: 'Skipped task', index: 1 }),
      makeTaskSkipped({ taskId: taskId('T002'), reason: 'dep failed' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    const summary = requireSection(sections, 0, 'completed-task').summary;
    expect(summary.method).toBe('skipped');
    expect(summary.reason).toBe('dep failed');
    expect(summary.retries).toBe(0);
    expect(summary.duration).toBe(0);
  });

  it('creates completed-task section for task-start + task-full-fail pair', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T003'), title: 'Failed task', index: 2, file: 'src/a.ts' }),
      { type: 'task_full_fail', ts: 10, phase: 'implementing', taskId: taskId('T003') } as const,
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    const section = requireSection(sections, 0, 'completed-task');

    expect(section.summary).toMatchObject({
      index: 3,
      title: 'Failed task',
      method: 'failed',
      retries: 0,
      duration: 0,
      file: 'src/a.ts',
    });
    expect(section.items).toEqual(events);
  });

  it('creates active-task section for unclosed task-start', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T001') }),
      makeImplementerGenerate({ status: 'running' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    expect(requireSection(sections, 0, 'active-task').items).toHaveLength(2);
  });

  it('treats task_reset as an abandoned attempt boundary before retry completion', () => {
    const reset = {
      type: 'task_reset',
      ts: 20,
      phase: 'implementing',
      taskId: taskId('T001'),
    } as const;
    const retryStart = makeTaskStart({ taskId: taskId('T001'), title: 'Retry auth', index: 0 });
    const retryComplete = makeTaskComplete({ taskId: taskId('T001'), method: 'local' });
    const events = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Auth', index: 0 }),
      makeImplementerGenerate({ status: 'running' }),
      reset,
      retryStart,
      retryComplete,
    ];

    const sections = groupEventsIntoSections(events);

    expect(sections).toHaveLength(2);
    expect(requireSection(sections, 0, 'events').items).toEqual(events.slice(0, 3));
    expect(requireSection(sections, 1, 'completed-task').items).toEqual([
      retryStart,
      retryComplete,
    ]);
  });

  it('abandons a previous open attempt when the same task starts again', () => {
    const retryStart = makeTaskStart({ taskId: taskId('T001'), title: 'Retry auth', index: 0 });
    const retryComplete = makeTaskComplete({ taskId: taskId('T001'), method: 'local' });
    const events = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Auth', index: 0 }),
      makeImplementerGenerate({ status: 'running' }),
      retryStart,
      retryComplete,
    ];

    const sections = groupEventsIntoSections(events);

    expect(sections).toHaveLength(2);
    expect(requireSection(sections, 0, 'events').items).toEqual(events.slice(0, 2));
    expect(requireSection(sections, 1, 'completed-task').summary.title).toBe('Retry auth');
  });

  it('handles multiple completed tasks in sequence', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T001'), index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
      makeTaskStart({ taskId: taskId('T002'), index: 1 }),
      makeTaskComplete({ taskId: taskId('T002') }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(2);
    requireSection(sections, 0, 'completed-task');
    requireSection(sections, 1, 'completed-task');
  });

  it('interleaved: events, task, events, task', () => {
    const events = [
      makePlannerText({ text: 'Start' }),
      makeTaskStart({ taskId: taskId('T001'), index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
      makePlannerText({ text: 'Middle' }),
      makeTaskStart({ taskId: taskId('T002'), index: 1 }),
      makeTaskComplete({ taskId: taskId('T002') }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(4);
    requireSection(sections, 0, 'events');
    requireSection(sections, 1, 'completed-task');
    requireSection(sections, 2, 'events');
    requireSection(sections, 3, 'completed-task');
  });
});

describe('diffEventKey', () => {
  it('gives two same-timestamp diffs distinct keys from their global render index', () => {
    const ts = 1234;
    const first = makeImplementerGenerate({ status: 'done', diff: '+ a', ts });
    const second = makeImplementerGenerate({ status: 'done', diff: '+ b', ts });

    expect(diffEventKey(first, 0)).not.toBe(diffEventKey(second, 1));
  });
});

describe('findLatestRenderableDiffKey', () => {
  it('skips completed-task sections and returns the latest live diff key', () => {
    const live = makeImplementerGenerate({ status: 'done', diff: '+ live', ts: 1234 });
    const sections: Section[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [makeImplementerGenerate({ status: 'done', diff: '+ old', ts: 1000 })],
      },
      {
        type: 'completed-task',
        items: [],
        startIndex: 1,
        summary: { index: 1, title: 'done', method: 'local', retries: 0, duration: 0 },
      },
      {
        type: 'active-task',
        startIndex: 2,
        items: [live],
      },
    ];

    // The live diff is the only item of the active-task section at startIndex 2, so its global render
    // index — and therefore its key — is 2.
    expect(findLatestRenderableDiffKey(sections)).toBe(diffEventKey(live, 2));
  });

  it('keys the latest diff by its global render index, not its array position', () => {
    const ts = 42;
    const earlier = makeImplementerGenerate({ status: 'done', diff: '+ earlier', ts });
    const latest = makeImplementerGenerate({ status: 'done', diff: '+ latest', ts });

    const sections: Section[] = [
      { type: 'events', startIndex: 0, items: [makePlannerText(), earlier, latest] },
    ];

    // Both diffs share a timestamp; the latest renderable one is at global index 2 and gets its own
    // unique key, so toggling it never collides with the earlier diff at index 1.
    expect(findLatestRenderableDiffKey(sections)).toBe(diffEventKey(latest, 2));
    expect(findLatestRenderableDiffKey(sections)).not.toBe(diffEventKey(earlier, 1));
  });
});
