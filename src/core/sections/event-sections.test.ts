import { describe, it, expect } from 'vitest';
import {
  groupEventsIntoSections,
  findLatestRenderableDiffKey,
  diffEventKey,
} from './event-sections.js';
import type { Section } from './event-sections.js';
import { taskId } from '../schemas/task.js';
import {
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeImplementerGenerate,
} from '#testing/helpers/events.js';

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
    const events = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Auth', index: 0 }),
      makeImplementerGenerate(),
      makeTaskComplete({ taskId: taskId('T001'), method: 'local', retries: 1, duration: 8000 }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    const summary = requireSection(sections, 0, 'completed-task').summary;
    expect(summary.index).toBe(1);
    expect(summary.title).toBe('Auth');
    expect(summary.method).toBe('local');
    expect(summary.retries).toBe(1);
    expect(summary.duration).toBe(8000);
  });

  it('preserves task-complete duration in milliseconds without unit conversion', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Auth', index: 0 }),
      makeTaskComplete({ taskId: taskId('T001'), duration: 1234 }),
    ];
    const sections = groupEventsIntoSections(events);
    const summary = requireSection(sections, 0, 'completed-task').summary;
    expect(summary.duration).toBe(1234);
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

  it('creates active-task section for unclosed task-start', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T001') }),
      makeImplementerGenerate({ status: 'running' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    expect(requireSection(sections, 0, 'active-task').items).toHaveLength(2);
  });

  it('handles events before first task as events section', () => {
    const events = [
      makePlannerText({ text: 'Planning...' }),
      makeTaskStart({ taskId: taskId('T001'), index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(2);
    requireSection(sections, 0, 'events');
    requireSection(sections, 1, 'completed-task');
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
        summary: { index: 1, title: 'done', method: 'local', retries: 0, duration: 0 },
      },
      {
        type: 'active-task',
        startIndex: 2,
        items: [live],
      },
    ];

    expect(findLatestRenderableDiffKey(sections)).toBe(diffEventKey(live));
    expect(findLatestRenderableDiffKey(sections)).toBe('implementer_generate_done:1234');
  });

  it('returns a key that is independent of the diff event array position', () => {
    const diff = makeImplementerGenerate({ status: 'done', diff: '+ d', ts: 42 });

    const atIndexOne: Section[] = [
      { type: 'events', startIndex: 0, items: [makePlannerText(), diff] },
    ];
    const atIndexZero: Section[] = [{ type: 'events', startIndex: 5, items: [diff] }];

    expect(findLatestRenderableDiffKey(atIndexOne)).toBe(findLatestRenderableDiffKey(atIndexZero));
  });
});
