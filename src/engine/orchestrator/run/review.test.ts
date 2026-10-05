import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  planFromTasks,
  rejectingTriageResult,
  typedCallPlanReviewAndTriage,
} from '#testing/helpers/typed-planner.js';
import { saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { runScheduledReview } from './review.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function pendingReview(): WorkflowState {
  return makeImplState([makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })], {
    pendingTriage: { inputs: [] },
    review: {
      scope: 'task',
      cycle: 2,
      at: '2026-10-04T00:00:00Z',
      outcome: 'fail',
      verification: [],
      verdict: {
        tasks: [{ id: makeTask().id, plan: 'met', note: '' }],
        criteria: [],
        findings: [
          {
            id: 'F1',
            kind: 'defect',
            severity: 'blocking',
            taskId: null,
            file: null,
            line: null,
            text: 'Preserve the error',
            acceptance: null,
            checkIds: null,
            criterionId: null,
          },
        ],
      },
    },
    fixCycles: { used: 2, allowance: 2, notes: [] },
  });
}

describe('runScheduledReview saved recovery', () => {
  it('halts a scheduled review at its cap and resumes triage with pending tasks intact', async () => {
    const ref = setupProject(dirs);
    const state = pendingReview();
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const triagePrompts: string[] = [];
    const callbacks = makeCallbacks().callbacks;
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        () => {
          throw new Error('The saved review must be reused');
        },
        (prompt) => {
          triagePrompts.push(prompt);
          return {
            ...rejectingTriageResult(prompt),
            rejected: [
              { findingId: 'F1', reason: 'The review concern is answered' },
              { findingId: 'U1', reason: 'The correction guides continuation' },
            ],
          };
        },
      ),
    });
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner });
    const args = { wctx, state, callbacks, setTrackedState: vi.fn() };
    const halted = await runScheduledReview(args);
    expect(halted.status).toBe('stopped');
    expect(halted.state.phase).toBe('implementing');
    expect(halted.state.reviewStatus).toBeUndefined();
    expect(halted.state.tasks).toEqual(state.tasks);
    expect(halted.state.review?.scope).toBe('task');
    expect(halted.state.pendingTriage).toEqual({ inputs: [] });
    expect(halted.state.pendingRecovery?.facts?.blocking).toBe(1);
    expect(halted.state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
    expect(triagePrompts).toEqual([]);
    const corrected = applyRecoveryAction({
      ...ref,
      state: halted.state,
      action: 'revise',
      comment: 'Keep the reviewed correction',
      bus,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);
    const continued = await runScheduledReview({ ...args, state: corrected.state });
    expect(continued.status).toBe('continue');
    expect(continued.state.phase).toBe('implementing');
    expect(continued.state.tasks).toEqual(state.tasks);
    expect(continued.state.fixCycles?.used).toBe(3);
    expect(triagePrompts).toHaveLength(1);
    expect(triagePrompts[0]).toContain('Keep the reviewed correction');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('keeps a twice-invalid triage error on the plan seat', async () => {
    const ref = setupProject(dirs);
    const state = { ...pendingReview(), fixCycles: { used: 0, allowance: 2, notes: [] } };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        () => {
          throw new Error('The saved review must be reused');
        },
        () => '{}',
      ),
    });
    const result = await runScheduledReview({
      wctx: makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
    });
    expect(result.status).toBe('stopped');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'seat-protocol-error',
      seat: 'plan',
    });
    expect(result.state.pendingRecovery?.availableActions).toContain('retry-same-worker');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });
});
