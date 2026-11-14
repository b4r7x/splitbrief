import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeState, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { formatResumeCommand } from '../../../core/recovery/resume-command.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent } from '../../events/types.js';
import { parkStoppedRun, raisePendingRecovery } from './halts.js';

describe('raisePendingRecovery', () => {
  it('persists the issue, publishes recovery_prompted at the step the run resumes at, and notifies setTrackedState', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const issue = makeRecoveryIssue();
      const state = makeState({ tasks: [makeTask({ id: 'T001' })] });
      let tracked: WorkflowState | undefined;

      const next = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue, (s) => {
        tracked = s;
      });

      expect(next.pendingRecovery).toEqual(issue);
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(issue);
      expect(tracked).toBe(next);
      const prompted = events.find((event) => event.type === 'recovery_prompted');
      expect(prompted).toMatchObject({
        issueId: issue.id,
        reason: issue.reason,
        headline: formatRecoveryHeadline(issue),
        resumeCommand: formatResumeCommand(sessionId, issue, false),
        issue,
        at: { kind: 'brief', taskId: 'T001', attempt: 0 },
      });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('still persists and publishes when no setTrackedState is given', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const issue = makeRecoveryIssue({ id: 'rec_2026_04_28_002' });
      const state = createInitialState('feature');

      const next = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue);

      expect(next.pendingRecovery).toEqual(issue);
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(issue);
      expect(events.some((event) => event.type === 'recovery_prompted')).toBe(true);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('parkStoppedRun', () => {
  it('parks the run at the step it picks up at and records the stop as a row', async () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const state = { ...createInitialState('feature'), phase: 'reviewing-spec' as const };

      const next = await parkStoppedRun({ projectDir, sessionId, bus }, state, false);

      const gate = { kind: 'gate', gate: 'spec' } as const;
      expect(next.interruptedStep).toMatchObject({ step: gate, source: 'user', cut: 'boundary' });
      expect(loadState({ projectDir, sessionId })?.interruptedStep).toMatchObject({
        step: gate,
        cut: 'boundary',
      });
      expect(events).toEqual([
        {
          type: 'turn_interrupted',
          ts: expect.any(Number),
          phase: 'reviewing-spec',
          source: 'user',
          at: 'boundary',
          step: gate,
        },
      ]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('a park already recorded stands: a second stop changes nothing and adds no row', async () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const parked = transition(
        { ...createInitialState('feature'), phase: 'planning' as const },
        {
          type: 'INTERRUPT_STEP',
          step: { kind: 'planner', call: 'plan' },
          source: 'watchdog',
          cut: 'mid-step',
        },
      );
      saveState({ projectDir, sessionId }, parked);

      const next = await parkStoppedRun({ projectDir, sessionId, bus }, parked, false);

      expect(next).toBe(parked);
      expect(loadState({ projectDir, sessionId })?.interruptedStep).toEqual(parked.interruptedStep);
      expect(events).toEqual([]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
