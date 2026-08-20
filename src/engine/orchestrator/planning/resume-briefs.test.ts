import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
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
  it('keeps an owner-less v4 resume parked without invoking approval', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state: parkedState({ tasks: [] }),
    });

    expect(result.disposition).toBe('parked');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('does not replay a clean approval without an owner-supplied recovery projection', async () => {
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

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'plan_approved')).toBe(false);
  });

  it('does not inspect or replay tasks.md while the owner projection is absent', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state: parkedState(),
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });
});
