import { describe, it, expect } from 'vitest';
import { groupEventsIntoSections, findLatestRenderableDiffEventIndex, findLatestEventByType } from './event-sections.js';
import type { Section } from './event-sections.js';
import { taskId } from '../types/state-actions.js';
import {
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeImplementerGenerate,
} from '#testing/helpers/events.js';

describe('groupEventsIntoSections', () => {
  it('returns empty array for empty events', () => {
    expect(groupEventsIntoSections([])).toEqual([]);
  });

  it('wraps non-task events in events section', () => {
    const events = [makePlannerText(), makePlannerText()];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.type).toBe('events');
    expect((sections[0] as Extract<Section, { type: 'events' }>).items).toHaveLength(2);
  });

  it('creates completed-task section for task-start + task-complete pair', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Auth', index: 0 }),
      makeImplementerGenerate(),
      makeTaskComplete({ taskId: taskId('T001'), method: 'local', retries: 1, duration: 8000 }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.type).toBe('completed-task');
    const summary = (sections[0] as Extract<Section, { type: 'completed-task' }>).summary;
    expect(summary.index).toBe(1);
    expect(summary.title).toBe('Auth');
    expect(summary.method).toBe('local');
    expect(summary.retries).toBe(1);
    expect(summary.duration).toBe(8);
  });

  it('creates completed-task section for task-start + task-skipped pair', () => {
    const events = [
      makeTaskStart({ taskId: taskId('T002'), title: 'Skipped task', index: 1 }),
      makeTaskSkipped({ taskId: taskId('T002'), reason: 'dep failed' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.type).toBe('completed-task');
    const summary = (sections[0] as Extract<Section, { type: 'completed-task' }>).summary;
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
    expect(sections[0]!.type).toBe('active-task');
    expect((sections[0] as Extract<Section, { type: 'active-task' }>).items).toHaveLength(2);
  });

  it('handles events before first task as events section', () => {
    const events = [
      makePlannerText({ text: 'Planning...' }),
      makeTaskStart({ taskId: taskId('T001'), index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.type).toBe('events');
    expect(sections[1]!.type).toBe('completed-task');
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
    expect(sections[0]!.type).toBe('completed-task');
    expect(sections[1]!.type).toBe('completed-task');
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
    expect(sections[0]!.type).toBe('events');
    expect(sections[1]!.type).toBe('completed-task');
    expect(sections[2]!.type).toBe('events');
    expect(sections[3]!.type).toBe('completed-task');
  });
});

describe('findLatestRenderableDiffEventIndex', () => {
  it('skips completed-task sections and returns the latest live diff', () => {
    const sections: Section[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [makeImplementerGenerate({ status: 'done', diff: '+ old' })],
      },
      {
        type: 'completed-task',
        summary: { index: 1, title: 'done', method: 'local', retries: 0, duration: 0 },
      },
      {
        type: 'active-task',
        startIndex: 2,
        items: [makeImplementerGenerate({ status: 'done', diff: '+ live' })],
      },
    ];

    expect(findLatestRenderableDiffEventIndex(sections)).toBe(2);
  });
});

describe('findLatestEventByType', () => {
  it('returns undefined for empty array', () => {
    expect(findLatestEventByType([], 'planner-text')).toBeUndefined();
  });

  it('returns the last matching event', () => {
    const e1 = makePlannerText({ text: 'first' });
    const e2 = makePlannerText({ text: 'second' });
    const result = findLatestEventByType([e1, e2], 'planner-text');
    expect(result).toBe(e2);
  });

  it('returns undefined when no event of that type exists', () => {
    const e = makePlannerText({ text: 'hello' });
    expect(findLatestEventByType([e], 'workflow-config')).toBeUndefined();
  });
});
