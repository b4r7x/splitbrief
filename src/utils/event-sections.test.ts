import { describe, it, expect } from 'vitest';
import { groupEventsIntoSections, estimateSectionHeight, findLatestDiffEventIndex } from './event-sections.js';
import type { Section } from './event-sections.js';
import {
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeImplementerGenerate,
  makeValidate,
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
      makeTaskStart({ taskId: 'T001', title: 'Auth', index: 0 }),
      makeImplementerGenerate(),
      makeTaskComplete({ taskId: 'T001', method: 'local', retries: 1, duration: 8000 }),
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
      makeTaskStart({ taskId: 'T002', title: 'Skipped task', index: 1 }),
      makeTaskSkipped({ taskId: 'T002', reason: 'dep failed' }),
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
      makeTaskStart({ taskId: 'T001' }),
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
      makeTaskStart({ taskId: 'T001', index: 0 }),
      makeTaskComplete({ taskId: 'T001' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.type).toBe('events');
    expect(sections[1]!.type).toBe('completed-task');
  });

  it('handles multiple completed tasks in sequence', () => {
    const events = [
      makeTaskStart({ taskId: 'T001', index: 0 }),
      makeTaskComplete({ taskId: 'T001' }),
      makeTaskStart({ taskId: 'T002', index: 1 }),
      makeTaskComplete({ taskId: 'T002' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.type).toBe('completed-task');
    expect(sections[1]!.type).toBe('completed-task');
  });

  it('interleaved: events, task, events, task', () => {
    const events = [
      makePlannerText({ text: 'Start' }),
      makeTaskStart({ taskId: 'T001', index: 0 }),
      makeTaskComplete({ taskId: 'T001' }),
      makePlannerText({ text: 'Middle' }),
      makeTaskStart({ taskId: 'T002', index: 1 }),
      makeTaskComplete({ taskId: 'T002' }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections).toHaveLength(4);
    expect(sections[0]!.type).toBe('events');
    expect(sections[1]!.type).toBe('completed-task');
    expect(sections[2]!.type).toBe('events');
    expect(sections[3]!.type).toBe('completed-task');
  });
});

describe('estimateSectionHeight', () => {
  it('returns 1 for completed-task section', () => {
    const section: Section = {
      type: 'completed-task',
      summary: { index: 1, title: 'Task', method: 'local', retries: 0, duration: 5 },
    };
    expect(estimateSectionHeight(section, new Set())).toBe(1);
  });

  it('sums event heights for events section', () => {
    const section: Section = {
      type: 'events',
      items: [makePlannerText(), makePlannerText()],
      startIndex: 0,
    };
    const height = estimateSectionHeight(section, new Set());
    expect(height).toBe(6);
  });

  it('accounts for diff expanded state', () => {
    const section: Section = {
      type: 'events',
      items: [makeImplementerGenerate({ status: 'done', diff: '+ line' })],
      startIndex: 5,
    };
    const collapsed = estimateSectionHeight(section, new Set());
    const expanded = estimateSectionHeight(section, new Set([5]));
    expect(expanded).toBeGreaterThan(collapsed);
  });
});

describe('findLatestDiffEventIndex', () => {
  it('returns null for empty events', () => {
    expect(findLatestDiffEventIndex([])).toBeNull();
  });

  it('returns null when no implementer-generate with done status and diff', () => {
    const events = [makePlannerText(), makeValidate()];
    expect(findLatestDiffEventIndex(events)).toBeNull();
  });

  it('returns index of last matching event', () => {
    const events = [
      makeImplementerGenerate({ status: 'done', diff: '+ first' }),
      makePlannerText(),
      makeImplementerGenerate({ status: 'done', diff: '+ second' }),
    ];
    expect(findLatestDiffEventIndex(events)).toBe(2);
  });

  it('ignores running status events', () => {
    const events = [
      makeImplementerGenerate({ status: 'done', diff: '+ line' }),
      makeImplementerGenerate({ status: 'running' }),
    ];
    expect(findLatestDiffEventIndex(events)).toBe(0);
  });
});
