import { describe, expect, it } from 'vitest';
import { groupEventsIntoSections } from '../../../core/sections/event-sections.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makeTaskComplete, makeTaskSkipped, makeTaskStart } from '#testing/helpers/events/task.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../core/sessions/workspace-notice.js';
import { retainedWorkspaceNotice } from '../../../engine/orchestrator/isolation/retention.js';
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

  it('keeps one activity batch across steerable call attachment and detachment', () => {
    const first = makeRunnerCallActivity({ ts: 1, callId: 'c1' });
    const second = makeRunnerCallActivity({ ts: 3, callId: 'c1', sequence: 3 });
    const attached: EngineEvent = {
      type: 'steerable_call',
      ts: 2,
      phase: 'implementing',
      seat: 'build',
      taskId: 'T003',
    };
    const detached: EngineEvent = { type: 'steerable_call', ts: 4, phase: 'implementing' };
    const steps = [...walkTranscript(groupEventsIntoSections([first, attached, second, detached]))];
    expect(steps.filter((step) => step.kind === 'activity-batch')).toEqual([
      {
        kind: 'activity-batch',
        batch: { callId: 'c1', firstIndex: 0, events: [first, second], lastEvent: second },
        callEnded: false,
      },
    ]);
  });

  it('keeps one recovery fold across steerable call changes', () => {
    const detached: EngineEvent = { type: 'steerable_call', ts: 1_500, phase: 'implementing' };
    const steps = [
      ...walkTranscript(groupEventsIntoSections([prompted, detached, selected, resolved])),
    ];
    expect(steps.filter((step) => step.kind === 'recovery')).toEqual([
      {
        kind: 'recovery',
        recovery: { firstIndex: 0, issueId: prompted.issueId, prompted, selected, resolved },
      },
    ]);
  });

  describe('an Apply recovery that resumes before its outcome', () => {
    const applyPrompted: EngineEventOf<'recovery_prompted'> = {
      type: 'recovery_prompted',
      ts: 1_000,
      phase: 'complete',
      issueId: 'apply-1',
      reason: 'apply-partial',
      headline: 'Apply stopped part way',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'restore-backup'],
      recommendedAction: 'retry-same-worker',
      resumeCommand: 'splitbrief continue',
    };
    const applySelected: EngineEventOf<'recovery_action_selected'> = {
      type: 'recovery_action_selected',
      ts: 2_000,
      phase: 'complete',
      issueId: applyPrompted.issueId,
      reason: applyPrompted.reason,
      action: 'retry-same-worker',
    };
    const resumed: EngineEvent = {
      type: 'workflow_resumed',
      ts: 3_000,
      phase: 'complete',
      inProcess: true,
    };
    const config: EngineEvent = {
      type: 'workflow_config',
      ts: 3_001,
      phase: 'complete',
      plannerTool: 'claude-code',
      implementerTool: 'opencode',
    };

    it('keeps one Recovery fold and shows the resume after it', () => {
      const applyResolved: EngineEventOf<'recovery_resolved'> = {
        type: 'recovery_resolved',
        ts: 4_000,
        phase: 'complete',
        issueId: applyPrompted.issueId,
        reason: applyPrompted.reason,
        action: 'retry-same-worker',
        outcome: 'continued',
      };
      const steps = [
        ...walkTranscript(
          groupEventsIntoSections([applyPrompted, applySelected, resumed, config, applyResolved]),
        ),
      ];

      expect(steps).toEqual([
        { kind: 'event', event: config, globalIndex: 3 },
        {
          kind: 'recovery',
          recovery: {
            firstIndex: 0,
            issueId: applyPrompted.issueId,
            prompted: applyPrompted,
            selected: applySelected,
            resolved: applyResolved,
          },
        },
        { kind: 'event', event: resumed, globalIndex: 2 },
      ]);
    });

    it('shows the resume after the open fold when no outcome follows', () => {
      const halt: EngineEvent = {
        type: 'error',
        ts: 5_000,
        phase: 'complete',
        message: 'Apply stopped part way',
      };
      const steps = [
        ...walkTranscript(groupEventsIntoSections([applyPrompted, applySelected, resumed, halt])),
      ];

      expect(steps).toEqual([
        {
          kind: 'recovery',
          recovery: {
            firstIndex: 0,
            issueId: applyPrompted.issueId,
            prompted: applyPrompted,
            selected: applySelected,
          },
        },
        { kind: 'event', event: resumed, globalIndex: 2 },
        { kind: 'event', event: halt, globalIndex: 3 },
      ]);
    });
  });

  it('keeps one Recovery fold and shows the correction typed with the choice after it', () => {
    const checksPrompted: EngineEventOf<'recovery_prompted'> = {
      type: 'recovery_prompted',
      ts: 1_000,
      phase: 'final-review',
      issueId: 'checks-1',
      reason: 'required-checks-unrunnable',
      headline: 'A required check could not run',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
      resumeCommand: 'splitbrief continue',
    };
    const checksSelected: EngineEventOf<'recovery_action_selected'> = {
      type: 'recovery_action_selected',
      ts: 2_000,
      phase: 'final-review',
      issueId: checksPrompted.issueId,
      reason: checksPrompted.reason,
      action: 'retry-same-worker',
    };
    const correction: EngineEvent = {
      type: 'user_message',
      ts: 2_500,
      phase: 'final-review',
      text: 'Replace K1',
    };
    const checksResolved: EngineEventOf<'recovery_resolved'> = {
      type: 'recovery_resolved',
      ts: 3_000,
      phase: 'final-review',
      issueId: checksPrompted.issueId,
      reason: checksPrompted.reason,
      action: 'retry-same-worker',
      outcome: 'continued',
    };
    const resumed: EngineEvent = { type: 'workflow_resumed', ts: 4_000, phase: 'final-review' };
    const steps = [
      ...walkTranscript(
        groupEventsIntoSections([
          checksPrompted,
          checksSelected,
          correction,
          checksResolved,
          resumed,
        ]),
      ),
    ];

    expect(steps).toEqual([
      {
        kind: 'recovery',
        recovery: {
          firstIndex: 0,
          issueId: checksPrompted.issueId,
          prompted: checksPrompted,
          selected: checksSelected,
          resolved: checksResolved,
        },
      },
      { kind: 'event', event: correction, globalIndex: 2 },
      { kind: 'event', event: resumed, globalIndex: 4 },
    ]);
  });

  it('keeps one Recovery fold for each choice that resets or skips the last brief', () => {
    const halt = (ts: number): EngineEvent => ({
      type: 'error',
      ts,
      phase: 'implementing',
      message: 'Your checkout changed under T001',
    });
    const checkoutPrompted = (issueId: string, ts: number): EngineEventOf<'recovery_prompted'> => ({
      type: 'recovery_prompted',
      ts,
      phase: 'implementing',
      issueId,
      reason: 'checkout-changed',
      taskId: taskId('T001'),
      headline: 'Your checkout changed while T001 ran',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'skip-current-task'],
      recommendedAction: 'retry-same-worker',
      resumeCommand: 'splitbrief continue',
    });
    const checkoutSelected = (
      issueId: string,
      action: 'retry-same-worker' | 'skip-current-task',
      ts: number,
    ): EngineEventOf<'recovery_action_selected'> => ({
      type: 'recovery_action_selected',
      ts,
      phase: 'implementing',
      issueId,
      reason: 'checkout-changed',
      action,
    });
    const checkoutResolved = (
      issueId: string,
      action: 'retry-same-worker' | 'skip-current-task',
      outcome: 'retry-current-task' | 'skipped-current-task',
      ts: number,
    ): EngineEventOf<'recovery_resolved'> => ({
      type: 'recovery_resolved',
      ts,
      phase: 'implementing',
      issueId,
      reason: 'checkout-changed',
      action,
      outcome,
    });
    const reset: EngineEvent = {
      type: 'task_reset',
      ts: 6_000,
      phase: 'implementing',
      taskId: taskId('T001'),
    };
    const events: EngineEvent[] = [
      makeTaskStart({ taskId: taskId('T001'), total: 1 }),
      makeRunnerCallActivity({ ts: 2_000, callId: 'c1', taskId: taskId('T001') }),
      halt(3_000),
      checkoutPrompted('p1', 4_000),
      checkoutSelected('p1', 'retry-same-worker', 5_000),
      reset,
      checkoutResolved('p1', 'retry-same-worker', 'retry-current-task', 7_000),
      { type: 'workflow_resumed', ts: 8_000, phase: 'implementing' },
      makeRunnerCallActivity({ ts: 9_000, callId: 'c2', taskId: taskId('T001') }),
      halt(10_000),
      checkoutPrompted('p2', 11_000),
      checkoutSelected('p2', 'skip-current-task', 12_000),
      {
        type: 'task_skipped',
        ts: 13_000,
        phase: 'implementing',
        taskId: taskId('T001'),
        title: 'Test task',
        reason: 'Skipped by you',
      },
      checkoutResolved('p2', 'skip-current-task', 'skipped-current-task', 14_000),
      { type: 'workflow_resumed', ts: 15_000, phase: 'final-review' },
      { type: 'review_started', ts: 16_000, phase: 'final-review', scope: 'final', tool: 'codex' },
    ];
    const recoveries = [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'recovery' ? [step.recovery] : [],
    );

    expect(recoveries).toHaveLength(2);
    expect(recoveries[0]).toMatchObject({
      issueId: 'p1',
      selected: events[4],
      reset,
      resolved: events[6],
    });
    expect(recoveries[1]).toMatchObject({
      issueId: 'p2',
      selected: events[11],
      resolved: events[13],
    });
  });

  it('keeps one Recovery fold for Skip task on a brief that never started, after a settled brief', () => {
    const blocked = {
      issueId: 'dep-T002',
      reason: 'dependency-blocked',
      phase: 'implementing',
    } as const;
    const events: EngineEvent[] = [
      makeTaskStart({ taskId: taskId('T001'), ts: 1_000 }),
      makeTaskSkipped({ taskId: taskId('T001'), ts: 2_000 }),
      { type: 'workflow_resumed', ts: 3_000, phase: 'implementing' },
      {
        ...blocked,
        type: 'recovery_prompted',
        ts: 4_000,
        taskId: taskId('T002'),
        headline: 'Dependency blocked on T002',
        files: [],
        affectedTaskIds: [taskId('T001'), taskId('T002')],
        availableActions: ['skip-current-task', 'end-run'],
        recommendedAction: 'skip-current-task',
        resumeCommand: 'splitbrief continue',
      },
      { ...blocked, type: 'recovery_action_selected', ts: 5_000, action: 'skip-current-task' },
      makeTaskSkipped({ taskId: taskId('T002'), ts: 6_000 }),
      {
        ...blocked,
        type: 'recovery_resolved',
        ts: 7_000,
        action: 'skip-current-task',
        outcome: 'skipped-current-task',
      },
    ];
    const recoveries = [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'recovery' ? [step.recovery] : [],
    );

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({
      issueId: 'dep-T002',
      prompted: events[3],
      selected: events[4],
      resolved: events[6],
    });
  });

  it('keeps halt deduplication across a steerable call change', () => {
    const halt: EngineEvent = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: prompted.headline,
    };
    const detached: EngineEvent = { type: 'steerable_call', ts: 500, phase: 'implementing' };
    const steps = [...walkTranscript(groupEventsIntoSections([halt, detached, prompted]))];
    expect(steps.filter((step) => step.kind === 'recovery')).toEqual([]);
  });

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
          recovery: {
            firstIndex: 0,
            issueId: prompted.issueId,
            prompted,
            selected,
            resolved,
            ...(auto
              ? { automaticSwitch: switchEvent, diagnostics: [] }
              : { seatSwitch: switchEvent }),
          },
        },
        {
          kind: 'event',
          event: switchEvent,
          globalIndex: 2,
          ...(auto && { causeInRecovery: true }),
        },
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
        recovery: {
          firstIndex: 0,
          issueId: prompted.issueId,
          prompted,
          selected,
          resolved,
          automaticSwitch: switched,
          diagnostics: [],
        },
      },
      { kind: 'event', event: switched, globalIndex: 2, causeInRecovery: true },
      { kind: 'event', event: message, globalIndex: 3 },
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
        'review-heading',
        'event',
        'event',
        'settled-end',
      ]);
      const final = steps[2];
      if (final?.kind !== 'review-heading') throw new Error('Expected the review heading');
      expect(final).toMatchObject({
        startIndex: 2,
        review: { stage: 'review', outcome: review, duration: 5_000 },
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
        .every(
          (step) =>
            step.kind !== 'settled' &&
            step.kind !== 'settled-end' &&
            step.kind !== 'review-heading' &&
            step.settledSection === heading.section,
        ),
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

  describe('the working on row of an attempt', () => {
    const T002 = taskId('T002');
    const running: EngineEventOf<'implementer_generate_running'> = {
      type: 'implementer_generate_running',
      ts: 2_000,
      phase: 'implementing',
      taskId: T002,
      file: 'src/strings.js',
    };
    const cutCall = makeRunnerCallActivity({
      ts: 3_000,
      taskId: T002,
      role: 'implementer',
      callId: 'implementer-2',
      activityId: 'implementer-2:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'SPLITBRIEF exited',
    });
    const runningRows = (events: EngineEvent[]) =>
      [...walkTranscript(groupEventsIntoSections(events))].filter(
        (step) => step.kind === 'event' && step.event.type === 'implementer_generate_running',
      );

    it('shows while its attempt runs', () => {
      expect(runningRows([makeTaskStart({ taskId: T002, ts: 1_000 }), running])).toHaveLength(1);
    });

    it('stays while an error-severity warning leaves its call running', () => {
      const warning = makeRunnerCallActivity({
        ts: 3_000,
        taskId: T002,
        role: 'implementer',
        callId: 'implementer-2',
        activityId: 'implementer-2:warning:rate-limit',
        stage: 'warning',
        kind: 'error',
        label: 'error claude_rate_limit',
        diagnosticPartial: 'Rate limit reached',
      });
      expect(
        runningRows([makeTaskStart({ taskId: T002, ts: 1_000 }), running, warning]),
      ).toHaveLength(1);
    });

    it.each([
      ['a call closed as interrupted', cutCall],
      [
        'a stop',
        {
          type: 'turn_interrupted',
          ts: 3_000,
          phase: 'implementing',
          source: 'user',
          at: 'mid-step',
        } satisfies EngineEvent,
      ],
      ['its result', makeImplementerGenerate({ taskId: T002, ts: 3_000 })],
    ])('goes once %s ends the attempt', (_label, end) => {
      expect(runningRows([makeTaskStart({ taskId: T002, ts: 1_000 }), running, end])).toEqual([]);
    });

    it('leaves one row for the attempt a resume starts after a cut one', () => {
      const rows = runningRows([
        makeTaskStart({ taskId: T002, ts: 1_000 }),
        running,
        cutCall,
        { type: 'workflow_resumed', ts: 4_000, phase: 'implementing' },
        makeTaskStart({ taskId: T002, ts: 5_000 }),
        { ...running, ts: 6_000 },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event: { ts: 6_000 } });
    });
  });
});

describe('walkTranscript on a stopped run’s workspace', () => {
  const kept: EngineEventOf<'warning'> = {
    type: 'warning',
    ts: 1_000,
    phase: 'implementing',
    message: retainedWorkspaceNotice('/trees/run'),
    category: WORKSPACE_NOTICE_CATEGORY,
    code: WORKSPACE_KEPT_CODE,
  };
  const patchSaved: EngineEventOf<'warning'> = {
    type: 'warning',
    ts: 2_000,
    phase: 'implementing',
    message: 'Run changes not applied are saved in run.patch; apply them with git apply.',
  };
  const closed: EngineEventOf<'workspace_closed'> = {
    type: 'workspace_closed',
    ts: 2_001,
    phase: 'implementing',
  };
  const eventsOf = (events: EngineEvent[]) =>
    [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'event' ? [step.event] : [],
    );

  it('keeps the kept-workspace notice while the run is open', () => {
    expect(eventsOf([kept])).toEqual([kept]);
  });

  it('shows only the latest workspace notice after repeated stops', () => {
    const resumed: EngineEvent = { type: 'workflow_resumed', ts: 1_100, phase: 'implementing' };
    const second = { ...kept, ts: 1_200 };
    const third = { ...kept, ts: 1_400 };
    expect(eventsOf([kept, resumed, second, { ...resumed, ts: 1_300 }, third])).toEqual([
      resumed,
      { ...resumed, ts: 1_300 },
      third,
    ]);
  });

  it('drops the kept-workspace notice once the run continues', () => {
    const resumed: EngineEvent = { type: 'workflow_resumed', ts: 1_100, phase: 'implementing' };
    expect(eventsOf([kept, resumed])).toEqual([resumed]);
  });

  it('shows the notice a stop after the continue kept again', () => {
    const resumed: EngineEvent = { type: 'workflow_resumed', ts: 1_100, phase: 'implementing' };
    const keptAgain = { ...kept, ts: 1_200 };
    expect(eventsOf([kept, resumed, keptAgain])).toEqual([resumed, keptAgain]);
  });

  // In a real run, End run removed the workspace, and the transcript still offered it for Continue.
  it('drops the kept-workspace notice once End run or Discard let the workspace go', () => {
    expect(eventsOf([kept, patchSaved, closed])).toEqual([patchSaved, closed]);
  });

  it('drops the kept-workspace notice once Apply let the workspace go', () => {
    expect(eventsOf([kept, closed])).toEqual([closed]);
  });
});
