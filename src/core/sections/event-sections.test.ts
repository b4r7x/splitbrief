import { describe, it, expect } from 'vitest';
import {
  groupEventsIntoSections,
  findLatestRenderableDiffKey,
  diffEventKey,
} from './event-sections.js';
import type { Section } from './event-sections.js';
import type { Phase } from '../schemas/enums.js';
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
    expect(summary.id).toBe('T001');
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

    expect(sections).toHaveLength(1);
    const completed = requireSection(sections, 0, 'completed-task');
    expect(completed.items).toEqual(events);
    expect(completed.startIndex).toBe(0);
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

    expect(sections).toHaveLength(1);
    const completed = requireSection(sections, 0, 'completed-task');
    expect(completed.items).toEqual(events);
    expect(completed.summary.title).toBe('Retry auth');
  });

  describe('an abandoned attempt joins its task', () => {
    const at = (type: string, fields: Record<string, unknown> = {}) => ({
      type,
      ts: 1,
      phase: 'implementing' as const,
      ...fields,
    });
    const start = (id: string, index: number) =>
      makeTaskStart({ taskId: taskId(id), title: id, index });
    const complete = (id: string) => makeTaskComplete({ taskId: taskId(id), retries: 1 });
    const retriedRun = () => [
      start('T002', 1),
      at('error', { message: 'Your checkout changed under T002' }),
      at('recovery_prompted', { issueId: 'i1', taskId: 'T002' }),
      at('recovery_action_selected', { issueId: 'i1', action: 'retry' }),
      at('task_reset', { taskId: 'T002' }),
      at('recovery_resolved', { issueId: 'i1', outcome: 'retry-current-task' }),
      start('T002', 1),
      complete('T002'),
      start('T003', 2),
      complete('T003'),
      start('T004', 3),
    ];

    it('folds the halt, the recovery and the retry into the completed task', () => {
      const events = retriedRun();
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual([
        'completed-task',
        'completed-task',
        'active-task',
      ]);
      const t002 = requireSection(sections, 0, 'completed-task');
      expect(t002.summary.id).toBe('T002');
      expect(t002.summary.retries).toBe(1);
      expect(t002.startIndex).toBe(0);
      expect(t002.items).toEqual(events.slice(0, 8));
      expect(requireSection(sections, 1, 'completed-task').summary.id).toBe('T003');
      expect(requireSection(sections, 2, 'active-task').startIndex).toBe(10);
    });

    it('starts the running retry at its first attempt', () => {
      const events = retriedRun().slice(0, 7);
      const sections = groupEventsIntoSections(events);

      expect(sections).toHaveLength(1);
      const active = requireSection(sections, 0, 'active-task');
      expect(active.startIndex).toBe(0);
      expect(active.items).toEqual(events);
    });

    it('keeps a reset with no restart as a loose section', () => {
      const events = [start('T002', 1), at('task_reset', { taskId: 'T002' })];
      const sections = groupEventsIntoSections(events);

      expect(sections).toHaveLength(1);
      expect(requireSection(sections, 0, 'events').items).toEqual(events);
    });

    it('folds a run-level error between two tasks into the task that closed before it', () => {
      const runError = at('error', { message: 'run-level' });
      const events = [start('T001', 0), complete('T001'), runError, start('T002', 1)];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual(['completed-task', 'active-task']);
      expect(requireSection(sections, 0, 'completed-task').items).toEqual(events.slice(0, 3));
      expect(requireSection(sections, 1, 'active-task').startIndex).toBe(3);
    });

    it('keeps attempts apart when another task ran between them', () => {
      const events = [
        start('T002', 1),
        at('task_reset', { taskId: 'T002' }),
        start('T003', 2),
        complete('T003'),
        start('T002', 1),
        complete('T002'),
      ];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual([
        'events',
        'completed-task',
        'completed-task',
      ]);
      expect(requireSection(sections, 2, 'completed-task').startIndex).toBe(4);
    });
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
      makePlannerText({ text: 'Start', phase: 'planning' }),
      makeTaskStart({ taskId: taskId('T001'), index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
      makePlannerText({ text: 'Middle', phase: 'final-review' }),
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

  // S11 run 3 (owner screenshot, 2026-10-07 20:10): rows no brief owned stayed above the live brief
  // for the rest of the run. A build row between briefs belongs to a brief and collapses with it.
  describe('a build row no brief owns joins a brief', () => {
    const row = (type: string, phase: Phase, fields: Record<string, unknown> = {}) => ({
      type,
      ts: 1,
      phase,
      ...fields,
    });
    const start = (id: string, index: number) =>
      makeTaskStart({ taskId: taskId(id), title: id, index });
    const complete = (id: string) => makeTaskComplete({ taskId: taskId(id) });
    const suite = (status: 'running' | 'done', moment: string) =>
      row('full_suite', 'implementing', { status, stage: 'test', command: 'npm test', moment });

    it('joins the boundary rows to the brief that closed before them once the next brief starts', () => {
      const events = [
        start('T004', 3),
        complete('T004'),
        row('task_touched_not_suggested', 'implementing', { taskId: 'T004', files: ['a.md'] }),
        row('task_tokens', 'implementing', { taskId: 'T004' }),
        suite('running', 'boundary'),
        suite('done', 'boundary'),
        start('T005', 4),
      ];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual(['completed-task', 'active-task']);
      expect(requireSection(sections, 0, 'completed-task').items).toEqual(events.slice(0, 6));
      const active = requireSection(sections, 1, 'active-task');
      expect(active.startIndex).toBe(6);
      expect(active.items).toEqual([events[6]]);
    });

    it('joins the run-start rows to the first brief and leaves the planning rows loose', () => {
      const planning = [
        row('planner_text', 'planning', { text: 'The plan' }),
        row('plan_approved', 'reviewing-plan'),
      ];
      const runStart = [
        row('tasks_planned', 'implementing', { tasks: [], total: 1 }),
        suite('running', 'baseline'),
        suite('done', 'baseline'),
        row('warning', 'implementing', { message: 'The test stage of the full suite timed out' }),
      ];
      const events = [...planning, ...runStart, start('T001', 0), complete('T001')];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual(['events', 'completed-task']);
      expect(requireSection(sections, 0, 'events').items).toEqual(planning);
      const first = requireSection(sections, 1, 'completed-task');
      expect(first.startIndex).toBe(2);
      expect(first.items).toEqual(events.slice(2));
    });

    it('keeps the run-start rows beside the first brief while it runs', () => {
      const events = [
        row('tasks_planned', 'implementing', { tasks: [], total: 1 }),
        row('warning', 'implementing', { message: 'run start' }),
        start('T001', 0),
      ];
      const sections = groupEventsIntoSections(events);

      expect(sections).toHaveLength(1);
      const active = requireSection(sections, 0, 'active-task');
      expect(active.startIndex).toBe(0);
      expect(active.items).toEqual(events);
    });

    it('keeps the rows after the last closed brief loose while no next brief has started', () => {
      const boundary = [suite('running', 'boundary'), suite('done', 'boundary')];
      const events = [start('T001', 0), complete('T001'), ...boundary];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual(['completed-task', 'events']);
      expect(requireSection(sections, 1, 'events').items).toEqual(boundary);
    });

    it('keeps the final review loose between the last brief and a fix brief', () => {
      const touched = row('task_touched_not_suggested', 'implementing', {
        taskId: 'T003',
        files: ['b.ts'],
      });
      const review = [
        row('warning', 'final-review', { message: 'Review packet written' }),
        row('planner_text', 'final-review', { text: 'Two blocking findings' }),
      ];
      const reentry = [
        row('review_fix_started', 'implementing', { cycle: 1, taskIds: ['T004'] }),
        row('tasks_planned', 'implementing', { tasks: [], total: 4 }),
      ];
      const events = [
        start('T003', 2),
        complete('T003'),
        touched,
        ...review,
        ...reentry,
        start('T004', 3),
      ];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual([
        'completed-task',
        'events',
        'active-task',
      ]);
      expect(requireSection(sections, 0, 'completed-task').items).toEqual(events.slice(0, 3));
      expect(requireSection(sections, 1, 'events').items).toEqual(events.slice(3, 5));
      expect(requireSection(sections, 2, 'active-task').startIndex).toBe(5);
    });
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
        summary: { index: 1, id: 'T001', title: 'done', method: 'local', retries: 0, duration: 0 },
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
