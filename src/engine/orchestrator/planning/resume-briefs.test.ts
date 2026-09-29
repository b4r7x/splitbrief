import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePassingTask, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { sessionDir, TASKS_FILE } from '../../../core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { parseTasks } from '../../spec/tasks/parse.js';
import { formatTasks } from '../../spec/formatter.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { OrchestratorCallbacks, PlannerCallbacksContext } from '../types.js';
import { resumeBriefsApproval } from './resume-briefs.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { transitionAndSave } from '../state-ops.js';

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
    config: makeConfig({ workflow: { mode: 'standard', approve: 'default' } }),
    callbacks: opts.callbacks,
    bus: opts.bus,
    metadata: TEST_METADATA,
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    planner: opts.planner,
  };
}

function briefsState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    ...createInitialState('feature'),
    phase: 'reviewing-briefs',
    mode: 'standard',
    approve: 'all',
    ...overrides,
  };
}

function writeBriefs(projectDir: string, sessionId: string): void {
  writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
}

describe('resumeBriefsApproval', () => {
  it('announces a tasks.md edit made while the briefs gate is parked, before implementation', async () => {
    const { projectDir, sessionId } = setupProject();
    const original = [makePassingTask('T001')];
    const edited = [{ ...makePassingTask('T002'), title: 'Edited while parked' }];
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(original), TEST_METADATA);
    const controller = new AbortController();
    const firstBus = makeBusRecorder().bus;
    const planner = makePlanner();
    const parked = await runBriefsApprovalLoop({
      projectDir,
      sessionId,
      planner,
      tasks: original,
      state: briefsState({ tasks: original }),
      config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
      metadata: TEST_METADATA,
      bus: firstBus,
      callbacks: makeCallbacks({
        onApprovalNeeded: async () => {
          controller.abort();
          return { approved: true };
        },
      }).callbacks,
      signal: controller.signal,
    });
    expect(parked.outcome).toBe('aborted');
    writeFileSync(tasksPath, formatTasks(edited));

    const { bus, events } = makeBusRecorder();
    const resumed = await resumeBriefsApproval({
      wctx: makeWctx({
        projectDir,
        sessionId,
        bus,
        planner,
        callbacks: makeCallbacks({ onApprovalNeeded: async () => ({ approved: true }) }).callbacks,
      }),
      state: loadState({ projectDir, sessionId })!,
    });

    expect(resumed).toMatchObject({ disposition: 'ready-for-tasks', tasks: [{ id: 'T002' }] });
    expect(
      events.filter((event) => event.type === 'artifact_written' && event.filename === TASKS_FILE),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === 'briefs_approved')).toBe(true);
    expect(
      events.filter(
        (event) => event.type === 'brief_quality_passed' || event.type === 'brief_quality_failed',
      ),
    ).toHaveLength(1);
    expect(planner.runPhase).not.toHaveBeenCalled();
    expect(planner.regenerate).not.toHaveBeenCalled();
  });

  it('does not announce a gate edit again after it was announced before a stop', async () => {
    const { projectDir, sessionId } = setupProject();
    const original = [makePassingTask('T001')];
    const edited = [{ ...makePassingTask('T002'), title: 'Edited in the gate' }];
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(original), TEST_METADATA);
    const controller = new AbortController();
    const queued = {
      id: 'queued-at-gate',
      text: 'Keep the parser requirement',
      queuedAt: '2026-01-01T00:00:00.000Z',
      phase: 'reviewing-briefs' as const,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending' as const,
    };
    const concurrentQueued = { ...queued, id: 'queued-during-card', text: 'Keep the new scope' };
    const { bus: recordingBus } = makeBusRecorder();
    let queuedDuringCard = false;
    const concurrentBus: EventBus = {
      ...recordingBus,
      publish: (event) => {
        recordingBus.publish(event);
        if (
          event.type === 'artifact_written' &&
          event.filename === TASKS_FILE &&
          !queuedDuringCard
        ) {
          queuedDuringCard = true;
          const ref = { projectDir, sessionId };
          const current = loadState(ref);
          expect(current).not.toBeNull();
          transitionAndSave(ref, current!, { type: 'ENQUEUE_USER_MSG', message: concurrentQueued });
        }
      },
    };
    let asks = 0;
    const parked = await runBriefsApprovalLoop({
      projectDir,
      sessionId,
      planner: makePlanner(),
      tasks: original,
      state: briefsState({ tasks: original, messageQueue: [queued] }),
      config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
      metadata: TEST_METADATA,
      bus: concurrentBus,
      callbacks: makeCallbacks({
        onApprovalNeeded: async () => {
          asks += 1;
          if (asks === 1) {
            writeFileSync(tasksPath, formatTasks(edited));
            return { approved: false, action: 'edit' };
          }
          controller.abort();
          return { approved: true };
        },
      }).callbacks,
      signal: controller.signal,
    });
    expect(parked.outcome).toBe('aborted');
    expect(loadState({ projectDir, sessionId })?.tasks.map((task) => task.id)).toEqual(['T002']);
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      phase: 'reviewing-briefs',
      attempt: 0,
      messageQueue: [queued, concurrentQueued],
    });

    const { bus, events } = makeBusRecorder();
    const resumed = await resumeBriefsApproval({
      wctx: makeWctx({
        projectDir,
        sessionId,
        bus,
        planner: makePlanner(),
        callbacks: makeCallbacks({ onApprovalNeeded: async () => ({ approved: true }) }).callbacks,
      }),
      state: loadState({ projectDir, sessionId })!,
    });

    expect(resumed.disposition).toBe('ready-for-tasks');
    expect(
      events.some((event) => event.type === 'artifact_written' && event.filename === TASKS_FILE),
    ).toBe(false);
  });

  it('keeps the prior saved briefs when their replacement card cannot be published', async () => {
    const { projectDir, sessionId } = setupProject();
    const original = [makePassingTask('T001')];
    const edited = [{ ...makePassingTask('T002'), title: 'Edited in the gate' }];
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(original), TEST_METADATA);
    const bus = makeBusRecorder().bus;
    const failingBus: EventBus = {
      ...bus,
      publish: (event) => {
        if (event.type === 'artifact_written') throw new Error('card unavailable');
        bus.publish(event);
      },
    };

    await expect(
      runBriefsApprovalLoop({
        projectDir,
        sessionId,
        planner: makePlanner(),
        tasks: original,
        state: briefsState({ tasks: original }),
        config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
        metadata: TEST_METADATA,
        bus: failingBus,
        callbacks: makeCallbacks({
          onApprovalNeeded: async () => {
            writeFileSync(tasksPath, formatTasks(edited));
            return { approved: true };
          },
        }).callbacks,
      }),
    ).rejects.toThrow('card unavailable');
    expect(loadState({ projectDir, sessionId })?.tasks.map((task) => task.id)).toEqual(['T001']);
  });

  it.each([
    { mode: 'quick' as const, approve: 'all' as const, configApprove: 'all' as const },
    { mode: 'standard' as const, approve: 'none' as const, configApprove: 'default' as const },
    { mode: 'speckit' as const, approve: 'all' as const, configApprove: 'none' as const },
  ])(
    'continues saved $mode briefs with effective level $configApprove without an omitted gate or a planning call',
    async ({ mode, approve, configApprove }) => {
      const { projectDir, sessionId } = setupProject();
      writeBriefs(projectDir, sessionId);
      const { callbacks } = makeCallbacks();
      const { bus } = makeBusRecorder();
      const planner = makePlanner();
      const wctx = makeWctx({ projectDir, sessionId, callbacks, bus, planner });
      wctx.config = makeConfig({ workflow: { mode: 'standard', approve: configApprove } });
      const result = await resumeBriefsApproval({ wctx, state: briefsState({ mode, approve }) });
      expect(result.disposition).toBe('ready-for-tasks');
      expect(result.state.phase).toBe('implementing');
      expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
      expect(planner.runPhase).not.toHaveBeenCalled();
      expect(planner.regenerate).not.toHaveBeenCalled();
    },
  );

  it('an idle saved state has no briefs review to resume', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: { ...createInitialState('feature'), phase: 'idle' },
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
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
    const { bus, events } = makeBusRecorder();

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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining('no last-announced Task Brief set'),
      }),
    );
  });

  it('ending the run at the briefs prompt closes it without changing the phase', async () => {
    const { projectDir, sessionId } = setupProject();
    writeBriefs(projectDir, sessionId);
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
    });
    const { bus } = makeBusRecorder();

    const result = await resumeBriefsApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, planner: makePlanner() }),
      state: briefsState(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'closed' });
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(result.state.closed?.as).toBe('ended');
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
