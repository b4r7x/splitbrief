import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { OrchestratorCallbacks, PlannerCallbacksContext } from '../types.js';
import { resumeBriefsApproval } from './resume-briefs.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('resume-briefs-test');
  dirs.push(projectDir);
  return { projectDir, sessionId: 'sess-resume-briefs' };
}

function makeWctx(opts: {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  planner: Planner;
}): PlannerCallbacksContext & { planner: Planner } {
  return {
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
    callbacks: opts.callbacks,
    bus: opts.bus,
    metadata: TEST_METADATA,
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    planner: opts.planner,
  };
}

function parkedState(overrides?: Partial<WorkflowState>): WorkflowState {
  return { ...createInitialState('feature'), phase: 'reviewing-briefs', ...overrides };
}

describe('resumeBriefsApproval', () => {
  it('fails loudly with the coded error when the briefs cannot be restored', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state: parkedState({ tasks: [] }),
    });

    expect(result.cancelled).toBe(true);
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ code: 'briefs_not_restorable' });
    expect(error?.message).toContain('tasks.md');
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('publishes the planner status and plan_approved on a clean approval', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn<OrchestratorCallbacks['onApprovalNeeded']>()
        .mockResolvedValue({ approved: true }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state: parkedState(),
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    const status = events.find((event) => event.type === 'planner_status');
    expect(status).toMatchObject({ status: 'running' });
    expect(events.some((event) => event.type === 'plan_approved')).toBe(true);
  });

  it('prefers the persisted tasks.md over state.tasks when both are present', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const briefsUnderReview: Task[] = [];
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn<OrchestratorCallbacks['onApprovalNeeded']>()
        .mockImplementation(async () => {
          const saved = loadState({ projectDir, sessionId });
          const first = saved?.tasks[0];
          if (first) briefsUnderReview.push(first);
          return { approved: true };
        }),
    });
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state: parkedState({ tasks: [makeTask()] }),
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(briefsUnderReview[0]?.title).toBe('Add auth');
  });
});
