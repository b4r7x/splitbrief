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
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import { parseTasks } from '../../spec/tasks/parse.js';
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
  const sessionId = 'sess-resume-briefs';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
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

function briefsState(overrides?: Partial<WorkflowState>): WorkflowState {
  return { ...createInitialState('feature'), phase: 'reviewing-briefs', ...overrides };
}

function writeBriefs(projectDir: string, sessionId: string): void {
  writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
}

describe('resumeBriefsApproval', () => {
  it('rejected persisted briefs surface terminal rejected', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: { ...createInitialState('feature'), phase: 'idle' },
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('fails terminally when the persisted Task Briefs are missing', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: briefsState(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      category: 'planning',
      code: 'briefs_not_restorable',
    });
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('falls back to the saved state tasks when tasks.md cannot be read', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: briefsState({ tasks: parseTasks(REAL_TASKS_MD) }),
    });

    const notRestorable = events.some(
      (event) => event.type === 'error' && event.code === 'briefs_not_restorable',
    );
    expect(notRestorable).toBe(false);
    expect(callbacks.onApprovalNeeded).toHaveBeenCalledWith(
      'briefs',
      expect.stringContaining(TASKS_FILE),
    );
    expect(result.disposition).toBe('ready-for-tasks');
  });

  it('accepted briefs surface ready-for-tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    writeBriefs(projectDir, sessionId);
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
    });
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: briefsState(),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(callbacks.onApprovalNeeded).toHaveBeenCalledWith(
      'briefs',
      expect.stringContaining(TASKS_FILE),
    );
  });

  it('briefs rejected at the prompt surface terminal rejected', async () => {
    const { projectDir, sessionId } = setupProject();
    writeBriefs(projectDir, sessionId);
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }),
    });
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: briefsState(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
  });

  it('an aborted briefs review surfaces terminal cancelled', async () => {
    const { projectDir, sessionId } = setupProject();
    writeBriefs(projectDir, sessionId);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const controller = new AbortController();
    controller.abort();

    const result = await resumeBriefsApproval({
      wctx: {
        ...makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
        signal: controller.signal,
      },
      state: briefsState(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('a failing briefs prompt surfaces terminal failed', async () => {
    const { projectDir, sessionId } = setupProject();
    writeBriefs(projectDir, sessionId);
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockRejectedValue(new Error('prompt unavailable')),
    });
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: briefsState(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
  });
});
