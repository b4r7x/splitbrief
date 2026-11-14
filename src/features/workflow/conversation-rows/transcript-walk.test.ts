import { describe, expect, it } from 'vitest';
import { groupEventsIntoSections } from '../../../core/sections/group.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makeTaskComplete, makeTaskSkipped, makeTaskStart } from '#testing/helpers/events/task.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makePlannerHeartbeat } from '#testing/helpers/events/planner.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../core/sessions/workspace-notice.js';
import { retainedWorkspaceNotice } from '../../../engine/orchestrator/isolation/retention.js';
import { projectRunnerCallEvents } from '../../../engine/calls/event-projection.js';
import type { RunnerCallEvent } from '../../../engine/calls/types.js';
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

    it('keeps one Recovery fold and drops the redundant resume after its outcome', () => {
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

      // A recovery answer states its outcome in the Recovery row, so the started resume is dropped.
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
      ]);
    });

    it('drops the resume after the open fold when no outcome follows', () => {
      const halt: EngineEvent = {
        type: 'error',
        ts: 5_000,
        phase: 'complete',
        message: 'Apply stopped part way',
      };
      const steps = [
        ...walkTranscript(groupEventsIntoSections([applyPrompted, applySelected, resumed, halt])),
      ];

      // A resume started by a recovery choice is dropped even when no outcome follows.
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

    // The correction remains after the Recovery row, while the redundant resume is dropped.
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
    ]);
  });

  it('drops the resume that a recovery answer started, after its outcome', () => {
    const prompt: EngineEventOf<'recovery_prompted'> = {
      type: 'recovery_prompted',
      ts: 1_000,
      phase: 'implementing',
      issueId: 'rec-1',
      reason: 'runner-usage-limit',
      headline: 'Balance spent on OpenCode CLI',
      files: [],
      affectedTaskIds: [],
      availableActions: ['switch-seat'],
      recommendedAction: 'switch-seat',
      resumeCommand: 'splitbrief continue',
    };
    const selection: EngineEventOf<'recovery_action_selected'> = {
      type: 'recovery_action_selected',
      ts: 2_000,
      phase: 'implementing',
      issueId: prompt.issueId,
      reason: prompt.reason,
      action: 'switch-seat',
      seat: 'build',
    };
    const correction: EngineEvent = {
      type: 'user_message',
      ts: 2_500,
      phase: 'implementing',
      text: 'Use deepseek-v4.1',
    };
    const resolvedContinued: EngineEventOf<'recovery_resolved'> = {
      type: 'recovery_resolved',
      ts: 3_000,
      phase: 'implementing',
      issueId: prompt.issueId,
      reason: prompt.reason,
      action: 'switch-seat',
      seat: 'build',
      outcome: 'continued',
    };
    const crewChangedSwitch: EngineEventOf<'seat_switched'> = {
      type: 'seat_switched',
      ts: 3_500,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'crew-changed',
      auto: false,
      configRevision: 'test-revision',
    };
    const resume: EngineEvent = {
      type: 'workflow_resumed',
      ts: 4_000,
      phase: 'implementing',
    };

    const steps = [
      ...walkTranscript(
        groupEventsIntoSections([
          prompt,
          selection,
          correction,
          resolvedContinued,
          crewChangedSwitch,
          resume,
        ]),
      ),
    ];

    expect(steps).toEqual([
      {
        kind: 'recovery',
        recovery: {
          firstIndex: 0,
          issueId: prompt.issueId,
          prompted: prompt,
          selected: selection,
          resolved: resolvedContinued,
        },
      },
      { kind: 'event', event: correction, globalIndex: 2 },
      { kind: 'event', event: crewChangedSwitch, globalIndex: 4 },
    ]);
  });

  it('keeps Run continued for a stop between the answer and the resume', () => {
    const prompt: EngineEventOf<'recovery_prompted'> = {
      type: 'recovery_prompted',
      ts: 1_000,
      phase: 'implementing',
      issueId: 'rec-2',
      reason: 'runner-usage-limit',
      headline: 'Balance spent on OpenCode CLI',
      files: [],
      affectedTaskIds: [],
      availableActions: ['switch-seat'],
      recommendedAction: 'switch-seat',
      resumeCommand: 'splitbrief continue',
    };
    const selection: EngineEventOf<'recovery_action_selected'> = {
      type: 'recovery_action_selected',
      ts: 2_000,
      phase: 'implementing',
      issueId: prompt.issueId,
      reason: prompt.reason,
      action: 'switch-seat',
      seat: 'build',
    };
    const stop: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 2_500,
      phase: 'implementing',
      source: 'user',
      at: 'boundary',
    };
    const resume: EngineEvent = {
      type: 'workflow_resumed',
      ts: 3_000,
      phase: 'implementing',
    };

    const steps = [...walkTranscript(groupEventsIntoSections([prompt, selection, stop, resume]))];

    expect(steps).toEqual([
      {
        kind: 'recovery',
        recovery: {
          firstIndex: 0,
          issueId: prompt.issueId,
          prompted: prompt,
          selected: selection,
        },
      },
      { kind: 'event', event: stop, globalIndex: 2 },
      { kind: 'event', event: resume, globalIndex: 3 },
    ]);
  });

  it('keeps Run continued when cancelled between the answer and the resume', () => {
    const prompt: EngineEventOf<'recovery_prompted'> = {
      type: 'recovery_prompted',
      ts: 1_000,
      phase: 'implementing',
      issueId: 'rec-3',
      reason: 'runner-usage-limit',
      headline: 'Balance spent on OpenCode CLI',
      files: [],
      affectedTaskIds: [],
      availableActions: ['switch-seat'],
      recommendedAction: 'switch-seat',
      resumeCommand: 'splitbrief continue',
    };
    const selection: EngineEventOf<'recovery_action_selected'> = {
      type: 'recovery_action_selected',
      ts: 2_000,
      phase: 'implementing',
      issueId: prompt.issueId,
      reason: prompt.reason,
      action: 'switch-seat',
      seat: 'build',
    };
    const cancel: EngineEventOf<'workflow_cancelled'> = {
      type: 'workflow_cancelled',
      ts: 2_500,
      phase: 'implementing',
      reason: 'user_cancelled',
    };
    const resume: EngineEvent = {
      type: 'workflow_resumed',
      ts: 3_000,
      phase: 'implementing',
    };

    const steps = [...walkTranscript(groupEventsIntoSections([prompt, selection, cancel, resume]))];

    expect(steps).toEqual([
      {
        kind: 'recovery',
        recovery: {
          firstIndex: 0,
          issueId: prompt.issueId,
          prompted: prompt,
          selected: selection,
        },
      },
      { kind: 'event', event: cancel, globalIndex: 2 },
      { kind: 'event', event: resume, globalIndex: 3 },
    ]);
  });

  it('keeps Run continued for a continue after a refused answer', () => {
    const refused: EngineEventOf<'recovery_action_failed'> = {
      type: 'recovery_action_failed',
      ts: 2_100,
      phase: 'implementing',
      issueId: prompted.issueId,
      reason: prompted.reason,
      action: 'skip-current-task',
      message: 'Failed to record skip evidence: EACCES',
    };
    const resume: EngineEvent = { type: 'workflow_resumed', ts: 9_000, phase: 'implementing' };

    const steps = [
      ...walkTranscript(
        groupEventsIntoSections([
          prompted,
          { ...selected, action: 'skip-current-task' },
          refused,
          resume,
        ]),
      ),
    ];

    expect(steps.filter((step) => step.kind === 'event').map((step) => step.event)).toEqual([
      refused,
      resume,
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

  describe('a consult answer that the criteria guard holds', () => {
    const T003 = taskId('T003');
    const T004 = taskId('T004');
    const T005 = taskId('T005');
    const asked: EngineEventOf<'planner_questions_asked'> = {
      type: 'planner_questions_asked',
      ts: 2_100,
      phase: 'implementing',
      questions: [{ id: 'Q1', type: 'input', text: 'T003 changes its criteria. Proceed?' }],
    };
    const running: EngineEventOf<'implementer_generate_running'> = {
      type: 'implementer_generate_running',
      ts: 2_200,
      phase: 'implementing',
      taskId: T003,
      file: 'src/module.ts',
    };
    const rewrite = (ts: number, revision: number): EngineEventOf<'consult_answered'> => ({
      type: 'consult_answered',
      ts,
      phase: 'implementing',
      taskId: T003,
      reason: 'failed',
      action: 'rewrite-task',
      diagnosis: 'The brief asked for the wrong module.',
      newTaskIds: null,
      revision,
    });
    const answeredSteps = (events: EngineEvent[]) =>
      [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
        step.kind === 'event' && step.event.type === 'consult_answered' ? [step.event] : [],
      );

    it('shows no step for a rewrite that no task_replaced follows', () => {
      const events: EngineEvent[] = [
        makeTaskStart({ taskId: T003, ts: 1_000, title: 'Wire the parser' }),
        rewrite(2_000, 2),
        asked,
        running,
      ];

      expect(answeredSteps(events)).toEqual([]);
    });

    it('shows no step for a split that no tasks_inserted follows', () => {
      const split: EngineEventOf<'consult_answered'> = {
        type: 'consult_answered',
        ts: 2_000,
        phase: 'implementing',
        taskId: T003,
        reason: 'failed',
        action: 'split-task',
        diagnosis: 'The brief carries two jobs.',
        newTaskIds: [T004, T005],
      };
      const events: EngineEvent[] = [
        makeTaskStart({ taskId: T003, ts: 1_000, title: 'Wire the parser' }),
        split,
        asked,
        running,
      ];

      expect(answeredSteps(events)).toEqual([]);
    });

    it('shows only the later rewrite of a brief whose first rewrite the guard held', () => {
      const laterRewrite = rewrite(2_300, 3);
      const events: EngineEvent[] = [
        makeTaskStart({ taskId: T003, ts: 1_000, title: 'Wire the parser' }),
        rewrite(2_000, 2),
        asked,
        running,
        laterRewrite,
        {
          type: 'task_replaced',
          ts: 2_400,
          phase: 'implementing',
          taskId: T003,
          revision: 3,
        },
      ];

      expect(answeredSteps(events)).toEqual([laterRewrite]);
    });

    it('keeps the step of a rewrite that its task_replaced follows', () => {
      const kept = rewrite(2_000, 2);
      const events: EngineEvent[] = [
        makeTaskStart({ taskId: T003, ts: 1_000, title: 'Wire the parser' }),
        kept,
        {
          type: 'task_replaced',
          ts: 2_200,
          phase: 'implementing',
          taskId: T003,
          revision: 2,
        },
      ];

      expect(answeredSteps(events)).toEqual([kept]);
    });

    it('keeps the step of a split that its tasks_inserted follows', () => {
      const split: EngineEventOf<'consult_answered'> = {
        type: 'consult_answered',
        ts: 2_000,
        phase: 'implementing',
        taskId: T003,
        reason: 'failed',
        action: 'split-task',
        diagnosis: 'The brief carries two jobs.',
        newTaskIds: [T004, T005],
      };
      const events: EngineEvent[] = [
        makeTaskStart({ taskId: T003, ts: 1_000, title: 'Wire the parser' }),
        split,
        {
          type: 'tasks_inserted',
          ts: 2_200,
          phase: 'implementing',
          parentId: T003,
          taskIds: [T004, T005],
        },
      ];

      expect(answeredSteps(events)).toEqual([split]);
    });

    it("keeps the step of a stuck review's rewrite answer", () => {
      const fix: EngineEventOf<'consult_answered'> = {
        type: 'consult_answered',
        ts: 2_000,
        phase: 'final-review',
        taskId: T003,
        reason: 'no-progress',
        action: 'rewrite-task',
        diagnosis: 'The fix brief edits the wrong file.',
        newTaskIds: [taskId('T905')],
      };
      const events: EngineEvent[] = [makeTaskStart({ taskId: T003, ts: 1_000 }), fix];

      expect(answeredSteps(events)).toEqual([fix]);
    });

    it('keeps the step of a guidance answer', () => {
      const guidance: EngineEventOf<'consult_answered'> = {
        type: 'consult_answered',
        ts: 2_000,
        phase: 'implementing',
        taskId: T003,
        reason: 'blocked',
        action: 'guidance',
        diagnosis: 'The export is missing.',
        newTaskIds: null,
      };
      const events: EngineEvent[] = [makeTaskStart({ taskId: T003, ts: 1_000 }), guidance];

      expect(answeredSteps(events)).toEqual([guidance]);
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

describe('walkTranscript after a crew change at a boundary', () => {
  const parked: EngineEventOf<'turn_interrupted'> = {
    type: 'turn_interrupted',
    ts: 1_000,
    phase: 'implementing',
    source: 'user',
    at: 'boundary',
    step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    cause: 'seat-change',
  };
  const switched: EngineEventOf<'seat_switched'> = {
    type: 'seat_switched',
    ts: 1_001,
    phase: 'implementing',
    seat: 'build',
    from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
    cause: 'crew-changed',
    auto: false,
    configRevision: 'test-revision',
  };
  const carriedOn: EngineEventOf<'workflow_resumed'> = {
    type: 'workflow_resumed',
    ts: 1_002,
    phase: 'implementing',
    cause: 'seat-change',
  };
  const continued: EngineEventOf<'workflow_resumed'> = {
    type: 'workflow_resumed',
    ts: 5_000,
    phase: 'implementing',
  };
  const stopAndContinue = (events: EngineEvent[]) =>
    [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'event' &&
      (step.event.type === 'workflow_resumed' || step.event.type === 'turn_interrupted')
        ? [step.event]
        : [],
    );

  // In a real run, a crew change at a brief boundary showed "Run continued" though nobody paused it.
  it('shows no stop and no continue for the run a crew change carried on', () => {
    expect(stopAndContinue([parked, switched, carriedOn])).toEqual([]);
  });

  it('shows the stop when the crew change did not carry the run on', () => {
    expect(stopAndContinue([parked])).toEqual([parked]);
  });

  it('shows the stop and the continue of a run continued later', () => {
    expect(stopAndContinue([parked, switched, continued])).toEqual([parked, continued]);
  });

  it('shows the continue row of a later stop', () => {
    const stopped: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 2_000,
      phase: 'implementing',
      source: 'user',
      at: 'boundary',
      step: parked.step,
    };
    expect(stopAndContinue([parked, switched, carriedOn, stopped, continued])).toEqual([
      stopped,
      continued,
    ]);
  });
});

describe('a BUILD call that retries after a network or server failure', () => {
  const T001 = taskId('T001');
  const taskStart = makeTaskStart({ taskId: T001, ts: 1_000 });
  const runningAttempt = (ts: number): EngineEventOf<'implementer_generate_running'> => ({
    type: 'implementer_generate_running',
    ts,
    phase: 'implementing',
    taskId: T001,
    file: 'src/features/workflow/conversation-rows/transcript-walk.ts',
  });
  const failedAttempt = (ts: number): EngineEventOf<'implementer_generate_failed'> => ({
    type: 'implementer_generate_failed',
    ts,
    phase: 'implementing',
    taskId: T001,
    error: 'getaddrinfo ENOTFOUND api.example.com',
  });
  const seatRetry = (attempt: number, ts: number): EngineEventOf<'seat_retry'> => ({
    type: 'seat_retry',
    ts,
    phase: 'implementing',
    seat: 'build',
    attempt,
    delayMs: 2_000 * attempt,
  });

  it('hides the failed row of each attempt that a BUILD retry follows', () => {
    const firstRunning = runningAttempt(1_100);
    const firstFailed = failedAttempt(1_200);
    const firstRetry = seatRetry(1, 1_300);
    const secondRunning = runningAttempt(3_300);
    const secondFailed = failedAttempt(3_400);
    const secondRetry = seatRetry(2, 3_500);
    const thirdRunning = runningAttempt(7_500);
    const done: EngineEventOf<'implementer_generate_done'> = {
      type: 'implementer_generate_done',
      ts: 7_600,
      phase: 'implementing',
      taskId: T001,
      file: 'src/features/workflow/conversation-rows/transcript-walk.ts',
      files: ['src/features/workflow/conversation-rows/transcript-walk.ts'],
      diff: '',
      linesAdded: 10,
      linesRemoved: 0,
      duration: 100,
    };
    const completed = makeTaskComplete({ taskId: T001, ts: 7_700 });
    const events: EngineEvent[] = [
      taskStart,
      firstRunning,
      firstFailed,
      firstRetry,
      secondRunning,
      secondFailed,
      secondRetry,
      thirdRunning,
      done,
      completed,
    ];

    const eventSteps = [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'event' ? [step.event] : [],
    );

    // A BUILD attempt a retry follows hides its failed row, while the retry events remain.
    expect(eventSteps.filter((event) => event.type === 'implementer_generate_failed')).toEqual([]);
    expect(eventSteps.filter((event) => event.type === 'seat_retry')).toEqual([
      firstRetry,
      secondRetry,
    ]);
  });

  it('keeps the failed row of the last attempt when no retry follows', () => {
    const firstRunning = runningAttempt(1_100);
    const firstFailed = failedAttempt(1_200);
    const firstRetry = seatRetry(1, 1_300);
    const secondRunning = runningAttempt(3_300);
    const secondFailed = failedAttempt(3_400);
    const events: EngineEvent[] = [
      taskStart,
      firstRunning,
      firstFailed,
      firstRetry,
      secondRunning,
      secondFailed,
    ];

    const eventSteps = [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'event' ? [step.event] : [],
    );

    // The first failed attempt was followed by a retry, but the second failed attempt had no retry following it.
    expect(eventSteps.filter((event) => event.type === 'implementer_generate_failed')).toEqual([
      secondFailed,
    ]);
    expect(eventSteps.filter((event) => event.type === 'seat_retry')).toEqual([firstRetry]);
  });

  it('keeps a BUILD failed row that a REVIEW retry follows', () => {
    const running = runningAttempt(1_100);
    const buildFailed = failedAttempt(1_200);
    const reviewRetry: EngineEventOf<'seat_retry'> = {
      type: 'seat_retry',
      ts: 1_300,
      phase: 'final-review',
      seat: 'review',
      attempt: 1,
      delayMs: 2_000,
    };
    const events: EngineEvent[] = [taskStart, running, buildFailed, reviewRetry];

    const eventSteps = [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'event' ? [step.event] : [],
    );

    // A REVIEW retry must not hide a BUILD failure.
    expect(eventSteps.filter((event) => event.type === 'implementer_generate_failed')).toEqual([
      buildFailed,
    ]);
    expect(eventSteps.filter((event) => event.type === 'seat_retry')).toEqual([reviewRetry]);
  });
});

describe('walkTranscript check groups', () => {
  const check = (id: string, ts: number): EngineEventOf<'full_suite'> => ({
    type: 'full_suite',
    ts,
    phase: 'final-review',
    status: 'done',
    id,
    command: `npm test -- ${id}`,
    moment: 'pre-review',
    passed: true,
  });
  const checks = (count: number, from = 1) =>
    Array.from({ length: count }, (_, index) => check(`K${from + index}`, from + index));
  const message: EngineEvent = {
    type: 'user_message',
    ts: 50,
    phase: 'final-review',
    text: 'Check this too.',
  };
  const heartbeat = (ts: number) => makePlannerHeartbeat({ ts, phase: 'final-review' });
  const steps = (events: EngineEvent[]) => [...walkTranscript(groupEventsIntoSections(events))];
  const kinds = (events: EngineEvent[]) => steps(events).map((step) => step.kind);

  it('folds a run of more than three checks at the end of a running review into one open step', () => {
    const run = checks(4);

    expect(steps(run)).toEqual([
      expect.objectContaining({ kind: 'review-heading' }),
      { kind: 'check-group', firstIndex: 0, checks: run, open: true },
    ]);
  });

  it('keeps a run of three checks as three rows', () => {
    const run = checks(3);

    expect(steps(run)).toEqual([
      expect.objectContaining({ kind: 'review-heading' }),
      ...run.map((event, globalIndex) => ({ kind: 'event', event, globalIndex })),
    ]);
  });

  it('ends a run at a row between its checks', () => {
    const first = checks(4);
    const second = checks(4, 5);
    const walked = steps([...first, message, ...second]);

    expect(walked.map((step) => step.kind)).toEqual([
      'review-heading',
      'check-group',
      'event',
      'check-group',
    ]);
    expect(walked.filter((step) => step.kind === 'check-group')).toEqual([
      { kind: 'check-group', firstIndex: 0, checks: first, open: false },
      { kind: 'check-group', firstIndex: 5, checks: second, open: true },
    ]);
    expect(kinds([...checks(4), message, ...checks(3, 5)])).toEqual([
      'review-heading',
      'check-group',
      'event',
      'event',
      'event',
      'event',
    ]);
  });

  it('ends a run at the activity of the reviewer call, which follows the group', () => {
    const run = checks(4);
    const read = makeRunnerCallActivity({
      ts: 60,
      phase: 'final-review',
      role: 'review',
      callId: 'review-call',
      kind: 'read',
      label: 'reading a.ts',
    });
    const walked = steps([...run, read]);

    expect(walked.map((step) => step.kind)).toEqual([
      'review-heading',
      'check-group',
      'activity-batch',
    ]);
    expect(walked[1]).toEqual({ kind: 'check-group', firstIndex: 0, checks: run, open: false });
    expect(walked[2]).toMatchObject({ batch: { firstIndex: 4, events: [read] } });
  });

  it('keeps a run whole across rowless events and starts it at the index of its first check', () => {
    const run = checks(4);
    const [first, second, third, fourth] = run;
    if (first === undefined || second === undefined || third === undefined || fourth === undefined)
      throw new Error('Expected four checks');
    const walked = steps([
      heartbeat(0),
      heartbeat(0),
      first,
      heartbeat(1),
      second,
      third,
      heartbeat(3),
      fourth,
    ]);

    expect(walked.map((step) => step.kind)).toEqual([
      'review-heading',
      'event',
      'event',
      'event',
      'event',
      'check-group',
    ]);
    expect(walked.at(-1)).toEqual({ kind: 'check-group', firstIndex: 2, checks: run, open: true });
  });

  it('closes a run of a settled review that is not open', () => {
    const review = { phase: 'final-review', scope: 'final', tool: 'claude-code' } as const;
    const run = checks(4);
    const events: EngineEvent[] = [
      { type: 'review_started', ts: 0, ...review },
      ...run,
      { type: 'review_completed', ts: 10, ...review, verdict: 'pass', duration: 10 },
    ];
    const sections = groupEventsIntoSections(events);
    const [section] = sections;

    expect(sections.map((candidate) => candidate.type)).toEqual(['settled-stage']);
    expect([...walkTranscript(sections)].filter((step) => step.kind === 'check-group')).toEqual([
      { kind: 'check-group', firstIndex: 1, checks: run, open: false, settledSection: section },
    ]);
  });

  it('keeps the checks of a BUILD brief as rows', () => {
    const briefChecks = checks(4).map(
      (event): EngineEvent => ({ ...event, phase: 'implementing', moment: 'brief' }),
    );

    expect(steps(briefChecks)).toEqual(
      briefChecks.map((event, globalIndex) => ({ kind: 'event', event, globalIndex })),
    );
  });
});

describe('a planner call that the run issues again on a fresh session', () => {
  const planCall = (callId: string, attempt: number) =>
    ({
      callId,
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-codex',
      attempt,
    }) as const;
  /** Call events as the workflow bus receives them: the typed event dropped, its activity kept. */
  const callActivity = (ts: number, events: readonly RunnerCallEvent[]): EngineEvent[] =>
    events
      .flatMap((event, index) =>
        projectRunnerCallEvents(
          { ...event, ts: ts + index },
          { rootDir: '/repo', phase: 'planning', sequence: index },
        ),
      )
      .filter((event) => event.type === 'runner_call_activity');
  const callWarning = (callId: string, ts: number): RunnerCallEvent => ({
    type: 'call_warning',
    ts,
    ...planCall(callId, 1),
    warning: {
      code: 'stderr_diagnostic',
      severity: 'warning',
      source: 'stderr',
      surface: 'status',
      channel: 'stderr',
      fingerprint: `rw:${callId}`,
      message:
        'Error: thread/resume: thread/resume failed: no rollout found for thread id 019a8c3e',
    },
  });
  const failedCall = (callId: string, ts: number, words: string): EngineEvent[] =>
    callActivity(ts, [
      callWarning(callId, ts),
      {
        type: 'call_error',
        ts,
        ...planCall(callId, 1),
        status: 'failed',
        error: { code: 'non-zero-exit', message: words },
        partial: true,
        startedAt: ts - 10,
        endedAt: ts,
        durationMs: 10,
        usage: null,
        nativeSessionId: null,
      },
    ]);
  const reissued = (code: string, ts: number): EngineEventOf<'debug'> => ({
    type: 'debug',
    ts,
    phase: 'planning',
    message: 'The call runs again on a fresh session with the conversation so far.',
    category: 'planner',
    code,
  });
  const freshRead = (ts: number) =>
    makeRunnerCallActivity('planner-read', { ts, phase: 'planning', callId: 'fresh' });
  const batchKinds = (events: EngineEvent[]) =>
    [...walkTranscript(groupEventsIntoSections(events))].flatMap((step) =>
      step.kind === 'activity-batch' ? [step.batch.events.map((event) => event.kind)] : [],
    );

  it.each(['planner_session_expired', 'planner_session_refused'])(
    'drops the warning and the error of the first call, when %s says the run asked again',
    (code) => {
      const events = [
        ...failedCall('first', 100, 'CLI exited with code 1'),
        reissued(code, 200),
        freshRead(300),
      ];

      expect(batchKinds(events)).toEqual([['read']]);
    },
  );

  it('keeps the warning and the error of the call issued again when that call fails too', () => {
    const events = [
      ...failedCall('first', 100, 'CLI exited with code 1'),
      reissued('planner_session_expired', 200),
      ...failedCall('fresh', 300, 'Prompt is too long'),
    ];

    expect(batchKinds(events)).toEqual([['warning', 'error']]);
  });

  it('keeps the warning of an earlier call when the run issues a later call again', () => {
    const events = [
      ...callActivity(50, [callWarning('earlier', 50)]),
      ...failedCall('first', 100, 'CLI exited with code 1'),
      reissued('planner_session_expired', 200),
      freshRead(300),
    ];

    expect(batchKinds(events)).toEqual([['warning'], ['read']]);
  });

  it('keeps the warning and the error of a planner call that the run did not issue again', () => {
    const events = [...failedCall('first', 100, 'CLI exited with code 1'), freshRead(300)];

    expect(batchKinds(events)).toEqual([['warning', 'error'], ['read']]);
  });

  it('keeps the error of an earlier call when the call that the run issued again left no error', () => {
    const events = [
      ...failedCall('first', 100, 'CLI exited with code 1'),
      freshRead(200),
      reissued('planner_session_expired', 300),
    ];

    expect(batchKinds(events)).toEqual([['warning', 'error'], ['read']]);
  });
});
