import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { createStorageBlockedRecovery } from '../planning/brief-recovery.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { createWorkflowRecoveryBinding } from './recovery-binding.js';
import { runPlanningPhases, type PhaseRecoveryBinding } from './phases.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../../core/schemas/brief-recovery.js';
import type { WorkflowContext, WorkflowSinks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { createValidator } from '../validation/run.js';

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const project = setupGitSessionProject({
    prefix: 'parked-phases-test',
    sessionId: 'sess-parked-phases',
  });
  dirs.push(project.projectDir);
  return project;
}

function makeWctx(opts: {
  projectDir: string;
  sessionId: string;
  callbacks?: ReturnType<typeof makeCallbacks>['callbacks'];
  bus: EventBus;
  planner?: ReturnType<typeof makePlanner>;
  workflow?: Record<string, unknown>;
}): WorkflowContext {
  const planner = opts.planner ?? makePlanner();
  return {
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    isolation: makeCopyingIsolation({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
    }),
    config: makeNoValidationConfig({ workflow: opts.workflow ?? {} }),
    callbacks: opts.callbacks ?? makeCallbacks().callbacks,
    bus: opts.bus,
    planner,
    reviewer: planner,
    context: defaultContext,
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
  };
}

function withFixtureAuthority<T extends WorkflowContext>(wctx: T): T {
  Object.defineProperty(wctx, 'stateAuthority', {
    configurable: true,
    enumerable: true,
    get: () => {
      const head = readWorkflowStateHead({
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
      });
      if (head === null) throw new Error('expected the canonical owner state head');
      const fence = head.state.stateFence;
      if (fence === undefined) throw new Error('expected the canonical owner state fence');
      return {
        kind: 'usable' as const,
        sessionId: wctx.sessionId,
        ownerId: fence.ownerId,
        pid: process.pid,
        processStart: 'parked-phases-test-process',
        runId: 'parked-phases-test-run',
        acquisitionId: 'parked-phases-test-acquisition',
        fence: fence.token,
        stateRevision: head.state.stateRevision ?? 0,
        stateDigest: head.digest,
      } satisfies StateAuthorityReceipt;
    },
  });
  return wctx;
}

function ownerRecoveryFixture(opts: { wctx: WorkflowContext; state: WorkflowState }): {
  recovery: PhaseRecoveryBinding;
  setTrackedState: (state: WorkflowState) => void;
} {
  withFixtureAuthority(opts.wctx);
  const { projectDir, sessionId } = opts.wctx;
  const ref = { projectDir, sessionId };
  let trackedState: WorkflowState = {
    ...opts.state,
    stateFence: { token: 1, ownerId: 'parked-phases-owner' },
  };
  saveState(ref, trackedState);
  const authorityBase: Omit<StateAuthorityReceipt, 'stateDigest' | 'stateRevision'> = {
    kind: 'usable',
    sessionId,
    ownerId: 'parked-phases-owner',
    pid: process.pid,
    processStart: 'parked-phases-process',
    runId: 'parked-phases-run',
    acquisitionId: 'parked-phases-acquisition',
    fence: 1,
  };
  const getState = (): WorkflowState => readWorkflowStateHead(ref)?.state ?? trackedState;
  const getAuthority = (): StateAuthorityReceipt => {
    const head = readWorkflowStateHead(ref);
    return {
      ...authorityBase,
      stateRevision: head?.state.stateRevision ?? trackedState.stateRevision ?? 0,
      stateDigest: head?.digest ?? '',
    };
  };
  const setTrackedState = (next: WorkflowState): void => {
    trackedState = next;
  };
  const recovery = createWorkflowRecoveryBinding({
    wctx: opts.wctx,
    getState,
    setState: setTrackedState,
    getAuthority,
  });
  Object.defineProperty(recovery, 'authority', {
    configurable: true,
    enumerable: true,
    get: getAuthority,
    set: () => {},
  });
  return { recovery, setTrackedState };
}

function failingQualityTask(): ReturnType<typeof makeTask> {
  return makeTask({
    id: 'T001',
    title: 'Missing scope task',
    file: 'src/parser.ts',
    description: 'A task with no scope definition.',
    tests: ['parser stays correct'],
    implementationSteps: ['Implement the parser branch.'],
  });
}

describe('runPlanningPhases — parked disposition', () => {
  it('parks a new quick run when the admission is blocked and never becomes ready', async () => {
    const { projectDir, sessionId } = setupProject();
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '# Plan',
      tasks: [failingQualityTask()],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const planner = makePlanner({ quickPlan });
    const onApprovalNeeded = vi.fn();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({
      projectDir,
      sessionId,
      callbacks,
      bus,
      planner,
      workflow: { mode: 'quick' },
    });
    const state = createInitialState('parked quick run');
    const owner = ownerRecoveryFixture({ wctx, state });

    const result = await runPlanningPhases({
      wctx,
      state,
      savedState: undefined,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') throw new Error('expected parked');
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(result.state.briefRecovery?.status).toBe('blocked');
    expect(result.projection.status).toBe('blocked');
    expect(result.projection.blocker).not.toBeNull();
    expect(quickPlan).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('keeps a resumed storage-blocked brief parked without provider or approval calls', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ review: vi.fn() });
    const onApprovalNeeded = vi.fn();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, callbacks, bus, planner });
    const parked: WorkflowState = {
      ...createInitialState('storage blocked resume'),
      phase: 'reviewing-briefs',
      briefRecovery: createStorageBlockedRecovery(
        {
          origin: { mode: 'standard', entry: 'initial' },
          continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
        },
        { epochId: 'epoch-storage-blocked', code: 'brief_storage_invalid' },
      ),
    };
    const owner = ownerRecoveryFixture({ wctx, state: parked });

    const result = await runPlanningPhases({
      wctx,
      state: parked,
      savedState: parked,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result).toMatchObject({ disposition: 'parked', state: { phase: 'reviewing-briefs' } });
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(planner.review).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'brief_quality_failed')).toBe(false);
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
  });

  it('returns ready only when the quick admission settles a current permit', async () => {
    const { projectDir, sessionId } = setupProject();
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '# Plan',
      tasks: [
        makeTask({
          id: 'T001',
          scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
          evidence: ['task_completed event shows the task ran'],
          typeDefs: 'type HelloTask = { file: string }',
        }),
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const planner = makePlanner({ quickPlan });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({
      projectDir,
      sessionId,
      callbacks,
      bus,
      planner,
      workflow: { mode: 'quick' },
    });
    const state = createInitialState('ready quick run');
    const owner = ownerRecoveryFixture({ wctx, state });

    const result = await runPlanningPhases({
      wctx,
      state,
      savedState: undefined,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.permit).not.toBeNull();
    expect(result.state.generation).not.toBeNull();
  });

  it('hydrates an absent-owner resume without mutating the persisted state', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ review: vi.fn() });
    const onApprovalNeeded = vi.fn();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, callbacks, bus, planner });
    const parked: WorkflowState = {
      ...createInitialState('absent owner resume'),
      phase: 'reviewing-briefs',
    };
    const ref = { projectDir, sessionId };
    saveState(ref, parked);
    const before = readWorkflowStateHead(ref);
    expect(before).not.toBeNull();

    const result = await runPlanningPhases({
      wctx,
      state: parked,
      savedState: parked,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'parked', state: { phase: 'reviewing-briefs' } });
    const after = readWorkflowStateHead(ref);
    expect(after?.digest).toBe(before?.digest);
    expect(after?.state.stateRevision).toBe(before?.state.stateRevision);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(planner.review).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
    expect(events.some((event) => event.type === 'brief_quality_failed')).toBe(false);
  });
});
