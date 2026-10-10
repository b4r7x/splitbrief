import { describe, expect, it } from 'vitest';
import { groupEventsIntoSections } from '../../../core/sections/event-sections.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makeTaskComplete, makeTaskStart } from '#testing/helpers/events/task.js';
import { walkTranscript } from './transcript-walk.js';

describe('walkTranscript', () => {
  const prompted: EngineEventOf<'recovery_prompted'> = {
    type: 'recovery_prompted',
    ts: 1_000,
    phase: 'implementing',
    issueId: 'balance-1',
    reason: 'runner-usage-limit',
    headline: 'Balance spent on OpenCode CLI',
    files: [],
    affectedTaskIds: [],
    availableActions: ['switch-seat'],
    recommendedAction: 'switch-seat',
    resumeCommand: 'splitbrief continue',
  };
  const selected: EngineEventOf<'recovery_action_selected'> = {
    type: 'recovery_action_selected',
    ts: 2_000,
    phase: 'implementing',
    issueId: prompted.issueId,
    reason: prompted.reason,
    action: 'switch-seat',
    seat: 'build',
  };
  const switched: EngineEventOf<'seat_switched'> = {
    type: 'seat_switched',
    ts: 3_000,
    phase: 'implementing',
    seat: 'build',
    from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
    cause: prompted.reason,
    auto: true,
    configRevision: 'test-revision',
  };
  const resolved: EngineEventOf<'recovery_resolved'> = {
    type: 'recovery_resolved',
    ts: 4_000,
    phase: 'implementing',
    issueId: prompted.issueId,
    reason: prompted.reason,
    action: 'switch-seat',
    seat: 'build',
    outcome: 'retry-current-task',
  };

  it.each([true, false])(
    'folds a seat switch with auto=%s into one recovery followed by its switch',
    (auto) => {
      const switchEvent = { ...switched, auto };
      const steps = [
        ...walkTranscript(groupEventsIntoSections([prompted, selected, switchEvent, resolved])),
      ];

      expect(steps).toEqual([
        {
          kind: 'recovery',
          recovery: { firstIndex: 0, issueId: prompted.issueId, prompted, selected, resolved },
        },
        { kind: 'event', event: switchEvent, globalIndex: 2 },
      ]);
    },
  );

  it('keeps an unrelated row between recovery groups', () => {
    const message: EngineEvent = {
      type: 'planner_text',
      ts: 3_500,
      phase: 'implementing',
      text: 'A separate update.',
    };
    const steps = [
      ...walkTranscript(groupEventsIntoSections([prompted, selected, switched, message, resolved])),
    ];

    expect(steps).toEqual([
      {
        kind: 'recovery',
        recovery: { firstIndex: 0, issueId: prompted.issueId, prompted, selected },
      },
      { kind: 'event', event: switched, globalIndex: 2 },
      { kind: 'event', event: message, globalIndex: 3 },
      {
        kind: 'recovery',
        recovery: { firstIndex: 4, issueId: resolved.issueId, resolved },
      },
    ]);
  });

  it.each(['passed', 'failed'] as const)(
    'yields one settled terminal %s Review heading followed by its body',
    (review) => {
      const events: EngineEvent[] = [
        makeTaskStart(),
        makeTaskComplete(),
        { type: 'planner_text', ts: 3_000, phase: 'final-review', text: 'Checking the diff.' },
        { type: 'workflow_complete', ts: 8_000, phase: 'complete', review },
      ];
      const steps = [...walkTranscript(groupEventsIntoSections(events))];
      expect(steps.map((step) => step.kind)).toEqual([
        'settled',
        'event',
        'settled',
        'event',
        'event',
      ]);
      const final = steps[2];
      if (final?.kind !== 'settled') throw new Error('Expected settled review');
      expect(final.section).toMatchObject({
        type: 'settled-stage',
        summary: { stage: 'review', outcome: review, duration: 5_000 },
      });
    },
  );
  it('yields settled plan, settled T001, then T002 events in order', () => {
    const planEvents: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'planning', feature: 'Add dark mode' },
      { type: 'user_message', ts: 1000, phase: 'planning', text: 'Add dark mode' },
      { type: 'plan_approved', ts: 2000, phase: 'reviewing-plan' },
    ];
    const t001Start = makeTaskStart({
      taskId: taskId('T001'),
      title: 'Wire theme',
      index: 0,
      total: 2,
      ts: 3000,
    });
    const t001Generate = makeImplementerGenerate({
      status: 'done',
      file: 'src/theme.ts',
      ts: 4000,
    });
    const t001Complete = makeTaskComplete({
      taskId: taskId('T001'),
      method: 'local',
      retries: 0,
      duration: 2000,
      ts: 5000,
    });
    const t002Start = makeTaskStart({
      taskId: taskId('T002'),
      title: 'Add toggle',
      index: 1,
      total: 2,
      ts: 6000,
    });
    const t002Generate = makeImplementerGenerate({
      status: 'running',
      file: 'src/toggle.ts',
      ts: 7000,
    });

    const events: EngineEvent[] = [
      ...planEvents,
      t001Start,
      t001Generate,
      t001Complete,
      t002Start,
      t002Generate,
    ];
    const sections = groupEventsIntoSections(events);
    const steps = [...walkTranscript(sections)];

    expect(steps.filter((step) => step.kind === 'settled')).toHaveLength(2);

    const first = steps[0];
    expect(first?.kind).toBe('settled');
    if (first?.kind === 'settled') {
      expect(first.section.type).toBe('settled-stage');
      if (first.section.type === 'settled-stage') {
        expect(first.section.summary.stage).toBe('plan');
        if (first.section.summary.stage === 'plan') {
          expect(first.section.summary.feature).toBe('Add dark mode');
        }
      }
    }

    const second = steps[4];
    expect(second?.kind).toBe('settled');
    if (second?.kind === 'settled') {
      expect(second.section.type).toBe('completed-task');
      if (second.section.type === 'completed-task') {
        expect(second.section.summary.id).toBe('T001');
        expect(second.section.summary.title).toBe('Wire theme');
      }
    }

    const third = steps[7];
    expect(third?.kind).toBe('event');
    if (third?.kind === 'event') {
      expect(third.event).toBe(t002Start);
    }

    const fourth = steps[8];
    expect(fourth?.kind).toBe('event');
    if (fourth?.kind === 'event') {
      expect(fourth.event).toBe(t002Generate);
    }
  });

  it('retains T001 narration, report, checks and recovery before T002 starts', () => {
    const events: EngineEvent[] = [
      makeTaskStart(),
      makeImplementerGenerate({ status: 'running', file: 'src/test.ts' }),
      {
        type: 'planner_text',
        ts: 1,
        phase: 'implementing',
        role: 'implementer',
        text: 'Kept narration.',
      },
      {
        type: 'full_suite',
        ts: 2,
        phase: 'implementing',
        status: 'done',
        stage: 'test',
        command: 'npm test',
        moment: 'brief',
        passed: true,
      },
      prompted,
      selected,
      switched,
      resolved,
      {
        type: 'planner_text',
        ts: 5,
        phase: 'implementing',
        role: 'implementer',
        text: 'Report completed.',
      },
      makeTaskComplete(),
      makeTaskStart({ taskId: taskId('T002'), index: 1 }),
    ];
    const steps = [...walkTranscript(groupEventsIntoSections(events))];
    const heading = steps[0];
    if (heading?.kind !== 'settled') throw new Error('Expected T001 heading');
    expect(steps.filter((step) => step.kind === 'settled')).toHaveLength(1);
    expect(steps.map((step) => step.kind)).toEqual([
      'settled',
      'event',
      'event',
      'recovery',
      'event',
      'event',
      'event',
      'event',
    ]);
    expect(steps.filter((step) => step.kind === 'event').map((step) => step.globalIndex)).toEqual([
      2, 3, 6, 8, 9, 10,
    ]);
    expect(
      steps
        .slice(1, -1)
        .every((step) => step.kind !== 'settled' && step.settledSection === heading.section),
    ).toBe(true);
    expect(steps.at(-1)).toEqual({ kind: 'event', event: events[10], globalIndex: 10 });
    expect(
      steps.some(
        (step) => step.kind === 'event' && step.event.type === 'implementer_generate_running',
      ),
    ).toBe(false);
    expect(steps.find((step) => step.kind === 'recovery')).toMatchObject({
      recovery: { firstIndex: 4, prompted, selected, resolved },
    });
  });
});
