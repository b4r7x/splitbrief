import { describe, it, expect } from 'vitest';
import {
  groupEventsIntoSections,
  findLatestRenderableDiffKey,
  diffEventKey,
  isSettledSection,
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

  it('interleaved: plan stage, task, review stage, task', () => {
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
    expect(requireSection(sections, 0, 'settled-stage').summary.stage).toBe('plan');
    requireSection(sections, 1, 'completed-task');
    expect(requireSection(sections, 2, 'settled-stage').summary.stage).toBe('review');
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

    it('joins the run-level rows to the first brief and settles the planning rows as the plan stage', () => {
      const planning = [
        row('planner_text', 'planning', { text: 'The plan' }),
        row('plan_approved', 'reviewing-plan'),
      ];
      const runLevel = [
        row('tasks_planned', 'implementing', { tasks: [], total: 1 }),
        suite('running', 'base'),
        suite('done', 'base'),
        row('warning', 'implementing', {
          message: 'Ignoring changed files that could not be read: src/tmp.lock.',
        }),
      ];
      const events = [...planning, ...runLevel, start('T001', 0), complete('T001')];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual(['settled-stage', 'completed-task']);
      expect(requireSection(sections, 0, 'settled-stage').items).toEqual(planning);
      const first = requireSection(sections, 1, 'completed-task');
      expect(first.startIndex).toBe(2);
      expect(first.items).toEqual(events.slice(2));
    });

    it('keeps the run-level rows beside the first brief while it runs', () => {
      const events = [
        row('tasks_planned', 'implementing', { tasks: [], total: 1 }),
        row('warning', 'implementing', {
          message: 'Ignoring changed files that could not be read: src/tmp.lock.',
        }),
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

    it('joins a task-scope review fix to the next brief without a loose events section', () => {
      const events = [
        start('T001', 0),
        complete('T001'),
        row('review_fix_started', 'implementing', { cycle: 1, taskIds: ['T002'] }),
        start('T002', 1),
      ];
      const sections = groupEventsIntoSections(events);

      expect(sections.map((section) => section.type)).toEqual(['completed-task', 'active-task']);
      expect(requireSection(sections, 0, 'completed-task').items).toEqual(events.slice(0, 2));
      const active = requireSection(sections, 1, 'active-task');
      expect(active.startIndex).toBe(2);
      expect(active.items).toEqual(events.slice(2));
    });

    it('settles the final review between the last brief and a fix brief, its fix cycle with it', () => {
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
        'settled-stage',
        'active-task',
      ]);
      expect(requireSection(sections, 0, 'completed-task').items).toEqual(events.slice(0, 3));
      expect(requireSection(sections, 1, 'settled-stage').items).toEqual(events.slice(3, 6));
      expect(requireSection(sections, 2, 'active-task').startIndex).toBe(6);
    });
  });

  // sb-RED (owner screenshot, 2026-10-08): under `Completed · 9/9 briefs passed` the transcript painted
  // first plan's Tasks card (T001–T005), its validation warning and two earlier pre-review cycles.
  // Each stage the run left settles in time order between the briefs; only the live stage is loose.
  describe('the stages a run left settle between its briefs', () => {
    const at = (type: string, phase: Phase, ts: number, fields: Record<string, unknown> = {}) => ({
      type,
      ts,
      phase,
      ...fields,
    });
    const start = (id: string, index: number) =>
      makeTaskStart({ taskId: taskId(id), title: id, index });
    const complete = (id: string) => makeTaskComplete({ taskId: taskId(id) });
    const suite = (ts: number, command: string, passed?: boolean) =>
      at('full_suite', 'final-review', ts, {
        status: passed === undefined ? 'running' : 'done',
        stage: command === 'npm test' ? 'test' : 'typecheck',
        command,
        moment: 'pre-review',
        ...(passed !== undefined && { passed, duration: 1000 }),
      });

    const plan = [
      at('workflow_started', 'planning', 1_000, { feature: 'Fix the red tests' }),
      at('user_message', 'planning', 1_000, { text: 'Fix the red tests' }),
      at('artifact_written', 'planning', 5_000, { filename: 'tasks.md' }),
      at('warning', 'planning', 5_000, { message: 'The test stage does not take the pattern' }),
      at('plan_approved', 'reviewing-plan', 9_000),
    ];
    const runStart = [at('tasks_planned', 'implementing', 9_100, { tasks: [], total: 2 })];
    const review1 = [
      at('all_tasks_done', 'final-review', 20_000),
      suite(21_000, 'npm run typecheck', true),
      suite(30_000, 'npm test', false),
      at('checks_run', 'final-review', 31_000, {
        taskId: 'T001',
        results: [
          { id: 'K-a', passed: false },
          { id: 'K-b', passed: true },
        ],
      }),
      at('runner_call_activity', 'final-review', 40_000, { role: 'review', callId: 'review-1' }),
      at('review_fix_started', 'implementing', 50_000, { cycle: 1, taskIds: ['T003', 'T004'] }),
    ];
    const reentry1 = [at('tasks_planned', 'implementing', 50_001, { tasks: [], total: 4 })];
    const review2 = [
      suite(60_000, 'npm run typecheck', false),
      suite(70_000, 'npm test', false),
      at('review_fix_started', 'implementing', 75_000, { cycle: 2, taskIds: ['T005'] }),
    ];
    const review3 = [suite(80_000, 'npm run typecheck', true), suite(81_000, 'npm test')];
    const events = [
      ...plan,
      ...runStart,
      start('T001', 0),
      complete('T001'),
      start('T002', 1),
      complete('T002'),
      ...review1,
      ...reentry1,
      start('T003', 2),
      complete('T003'),
      start('T004', 3),
      complete('T004'),
      ...review2,
      start('T005', 4),
      complete('T005'),
      ...review3,
    ];

    it('reads Plan, the briefs, each review cycle and its fix briefs in time order, with the live cycle last', () => {
      const sections = groupEventsIntoSections(events);

      expect(
        sections.map((section) =>
          section.type === 'completed-task'
            ? section.summary.id
            : section.type === 'settled-stage'
              ? section.summary.stage
              : section.type,
        ),
      ).toEqual(['plan', 'T001', 'T002', 'review', 'T003', 'T004', 'review', 'T005', 'events']);
      expect(requireSection(sections, 8, 'events').items).toEqual(review3);
    });

    it('settles the plan with its own rows only and names the run it planned', () => {
      const sections = groupEventsIntoSections(events);
      const planStage = requireSection(sections, 0, 'settled-stage');

      expect(planStage.items).toEqual(plan);
      expect(planStage.summary).toEqual({
        stage: 'plan',
        feature: 'Fix the red tests',
        duration: 8_000,
      });
      expect(requireSection(sections, 1, 'completed-task').startIndex).toBe(plan.length);
    });

    it('closes each review cycle on the fix cycle it started and counts the cycles', () => {
      const sections = groupEventsIntoSections(events);
      const first = requireSection(sections, 3, 'settled-stage');
      const second = requireSection(sections, 6, 'settled-stage');

      expect(first.items).toEqual(review1);
      expect(first.summary).toEqual({
        stage: 'review',
        ordinal: 1,
        failedCommands: ['npm test'],
        failedChecks: 1,
        fixes: ['T003', 'T004'],
        duration: 30_000,
      });
      expect(requireSection(sections, 4, 'completed-task').items[0]).toEqual(reentry1[0]);
      expect(second.items).toEqual(review2);
      expect(second.summary).toEqual({
        stage: 'review',
        ordinal: 2,
        failedCommands: ['npm run typecheck', 'npm test'],
        failedChecks: 0,
        fixes: ['T005'],
        duration: 15_000,
      });
    });

    it('settles a review that passed between two batches with no fix cycle', () => {
      const passed = [
        suite(20_000, 'npm test', true),
        at('warning', 'final-review', 21_000, { message: 'ok' }),
      ];
      const sections = groupEventsIntoSections([
        start('T001', 0),
        complete('T001'),
        ...passed,
        start('T002', 1),
      ]);

      expect(requireSection(sections, 1, 'settled-stage').summary).toEqual({
        stage: 'review',
        ordinal: 1,
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1_000,
      });
    });

    it('keeps the plan live while no brief has started', () => {
      const sections = groupEventsIntoSections([...plan, ...runStart]);

      expect(sections.map((section) => section.type)).toEqual(['events']);
    });

    it('deduplicates failed commands, counts every failed check and uses the last fix boundary', () => {
      const sections = groupEventsIntoSections([
        start('T001', 0),
        complete('T001'),
        suite(20_000, 'npm test', false),
        suite(21_000, 'npm test', false),
        at('checks_run', 'final-review', 22_000, { results: [{ passed: false }] }),
        at('checks_run', 'final-review', 23_000, {
          results: [{ passed: true }, { passed: false }, { passed: false }],
        }),
        at('review_fix_started', 'implementing', 24_000, { taskIds: ['T002'] }),
        at('review_fix_started', 'implementing', 25_000, { taskIds: ['T003', 'T004'] }),
        start('T003', 2),
      ]);

      expect(requireSection(sections, 1, 'settled-stage').summary).toEqual({
        stage: 'review',
        ordinal: 1,
        failedCommands: ['npm test'],
        failedChecks: 3,
        fixes: ['T003', 'T004'],
        duration: 5_000,
      });
    });

    it('names only the pre-review commands as failed, not the red base re-run that marks them pre-existing', () => {
      const sections = groupEventsIntoSections([
        start('T001', 0),
        complete('T001'),
        suite(20_000, 'npm test', false),
        at('full_suite', 'final-review', 21_000, {
          status: 'done',
          stage: 'test',
          command: 'npx vitest run src/legacy.test.ts',
          moment: 'base',
          passed: false,
          duration: 500,
        }),
        at('review_fix_started', 'implementing', 22_000, { taskIds: ['T002'] }),
        start('T002', 1),
      ]);

      expect(requireSection(sections, 1, 'settled-stage').summary).toMatchObject({
        stage: 'review',
        failedCommands: ['npm test'],
      });
    });

    it('counts a red reviewer check as a failed command, not its refused, skipped or base rows', () => {
      const check = (ts: number, id: string, fields: Record<string, unknown>) =>
        at('full_suite', 'final-review', ts, { id, moment: 'pre-review', ...fields });
      const sections = groupEventsIntoSections([
        start('T001', 0),
        complete('T001'),
        at('review_checks', 'final-review', 19_000, { scope: 'final', status: 'planned' }),
        check(19_500, 'V1', { status: 'refused', command: 'npm run lint', detail: 'changed' }),
        check(20_000, 'V2', { status: 'done', command: 'npm run typecheck', passed: true }),
        check(20_500, 'V3', { status: 'done', command: 'npm test', passed: false }),
        check(21_000, 'V3', { status: 'done', command: 'npm test', moment: 'base', passed: false }),
        check(21_500, 'V4', { status: 'not-run', command: 'make test', detail: 'V3 failed' }),
        at('review_fix_started', 'implementing', 22_000, { taskIds: ['T002'] }),
        start('T002', 1),
      ]);

      expect(requireSection(sections, 1, 'settled-stage').summary).toMatchObject({
        stage: 'review',
        failedCommands: ['npm test'],
        fixes: ['T002'],
      });
    });

    it('ignores untimed rows and uses zero duration when a stage has only one timestamp', () => {
      const sections = groupEventsIntoSections([
        { type: 'planner_text', phase: 'planning' } as const,
        at('warning', 'planning', 5_000),
        start('T001', 0),
      ]);

      expect(requireSection(sections, 0, 'settled-stage').summary).toEqual({
        stage: 'plan',
        feature: '',
        duration: 0,
      });
    });

    it('is the one predicate every consumer reads for a section the ledger owns', () => {
      const sections = groupEventsIntoSections(events);

      expect(sections.filter(isSettledSection).map((section) => section.startIndex)).toEqual(
        sections.slice(0, 8).map((section) => section.startIndex),
      );
      expect(isSettledSection(requireSection(sections, 8, 'events'))).toBe(false);
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
  it('skips diffs inside settled stages', () => {
    const live = makeImplementerGenerate({ status: 'done', diff: '+ live' });
    const sections: Section[] = [
      { type: 'events', startIndex: 0, items: [live] },
      {
        type: 'settled-stage',
        startIndex: 1,
        items: [makeImplementerGenerate({ status: 'done', diff: '+ settled' })],
        summary: {
          stage: 'review',
          ordinal: 1,
          failedCommands: [],
          failedChecks: 0,
          fixes: [],
          duration: 0,
        },
      },
    ];

    expect(findLatestRenderableDiffKey(sections)).toBe(diffEventKey(live, 0));
  });

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
        summary: { id: 'T001', title: 'done', method: 'local', retries: 0, duration: 0 },
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
