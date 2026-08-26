import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { formatTasks } from '../../spec/formatter.js';
import { createInitialState } from '../../../core/state/machine.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryCommand,
  BriefRecoveryController,
  QueueBriefInput,
  QueueResultV1,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ApprovalReviewInput } from '../../runners/types.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir, readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { saveState } from '../../../core/state/persistence.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../../core/paths.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { createBriefRecoveryState, inspectBriefRecovery } from '../planning/brief-recovery.js';
import { reviewAutoSplitOutput } from './auto-split-review.js';
import type { PhaseRecoveryBinding } from './phases.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
  vi.restoreAllMocks();
});

const QUALITY_POLICY_VERSION = 'quality-v1';

function authority(sessionId: string): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'owner-auto-split',
    pid: 1,
    processStart: 'start-auto-split',
    runId: 'run-auto-split',
    acquisitionId: 'acquisition-auto-split',
    fence: 1,
    stateRevision: 0,
    stateDigest: 'digest-auto-split',
  };
}

function admission(projectDir: string, sessionId: string, briefText: string): BriefAdmissionInput {
  const briefHash = sha256Hex(briefText);
  const reportBody = JSON.stringify({ briefHash, ruleVersion: QUALITY_POLICY_VERSION });
  writeSpecFile({ projectDir, sessionId }, BRIEF_QUALITY_FILE, reportBody, null);
  return {
    sessionId,
    origin: { mode: 'standard', entry: 'auto-split' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'auto-split' },
    activeBrief: { revision: 1, hash: briefHash, path: TASKS_FILE },
    report: {
      briefHash,
      report: { revision: 1, hash: sha256Hex(reportBody), path: BRIEF_QUALITY_FILE },
      ruleVersion: QUALITY_POLICY_VERSION,
      issues: [],
      errorCount: 0,
    },
    qualityPolicyVersion: QUALITY_POLICY_VERSION,
  };
}

function baseState(): WorkflowState {
  return { ...createInitialState('auto-split'), phase: 'reviewing-briefs' };
}

function makeRecovery(
  sessionId: string,
  initialStatus: 'blocked' | 'ready',
  initialState: WorkflowState,
  projectDir: string,
  admissionFailure = false,
): { binding: PhaseRecoveryBinding; commands: BriefRecoveryCommand[] } {
  const initialInput = admission(projectDir, sessionId, formatTasks(initialState.tasks));
  let recoveryState = createBriefRecoveryState(initialInput, { status: initialStatus });
  let state = initialState;
  const commands: BriefRecoveryCommand[] = [];
  const currentProjection = () =>
    inspectBriefRecovery({
      sessionId,
      stateRevision: state.stateRevision ?? 0,
      state: recoveryState,
    });
  const persistRecovery = () => {
    state = { ...state, phase: 'reviewing-briefs', briefRecovery: recoveryState };
    saveState({ projectDir, sessionId }, state);
  };
  const resultFor = (
    kind: RecoveryResultV1['kind'],
    operationId: string | null = null,
  ): RecoveryResultV1 => {
    if (kind === 'ready')
      return {
        version: 1,
        sessionId,
        epochId: recoveryState.epochId,
        kind: 'ready',
        operationId: null,
        projection: currentProjection(),
      };
    if (kind === 'rejected')
      return {
        version: 1,
        sessionId,
        epochId: recoveryState.epochId,
        kind: 'rejected',
        operationId,
        projection: currentProjection(),
      };
    return {
      version: 1,
      sessionId,
      epochId: recoveryState.epochId,
      kind: 'blocked',
      code: 'brief_contract_blocked',
      operationId,
      reason: 'Brief remains blocked until a conscious action settles it.',
      projection: currentProjection(),
    };
  };
  const controller: BriefRecoveryController = {
    inspectBriefRecovery: () => currentProjection(),
    enterBriefAdmission: async (input) => {
      if (admissionFailure) throw new Error('simulated brief admission failure');
      recoveryState = createBriefRecoveryState(input, { status: initialStatus });
      persistRecovery();
      return resultFor(initialStatus === 'ready' ? 'ready' : 'blocked');
    },
    dispatchBriefAction: async (command) => {
      commands.push(command);
      if (command.action === 'status') return resultFor('blocked');
      if (command.action === 'approve') {
        recoveryState = { ...recoveryState, status: 'ready' };
        persistRecovery();
        return resultFor('ready');
      }
      if (command.action === 'reject') {
        return resultFor('rejected', command.operationId);
      }
      if (command.action === 'retry') {
        return resultFor('blocked', command.operationId);
      }
      if (command.action !== 'edit') return resultFor('blocked', command.operationId);
      const editedInput = admission(projectDir, sessionId, command.briefText);
      recoveryState = createBriefRecoveryState(editedInput, { status: 'ready' });
      persistRecovery();
      return resultFor('ready', command.operationId);
    },
    queueBriefInput: async (input: QueueBriefInput): Promise<QueueResultV1> => ({
      version: 1,
      sessionId,
      epochId: input.epochId,
      kind: 'accepted',
      input: {
        inputId: input.inputId,
        epochId: input.epochId,
        sequence: input.sequence,
        kind: input.kind,
        source: input.source,
        payloadRef: input.base,
        textHash: 'a'.repeat(64),
        state: 'queued',
        operationId: input.operationId,
        appliedRevision: null,
        remoteObservation: null,
        history: [
          {
            state: 'queued',
            at: '2026-08-13T00:00:00.000Z',
            operationId: input.operationId,
            remoteObservation: null,
          },
        ],
      },
      projection: currentProjection(),
    }),
    settlePlannerAttempt: async () => resultFor('blocked'),
    migrateBriefRecovery: async () => {
      throw new Error('unused in auto-split review');
    },
  };
  return {
    binding: {
      controller,
      authority: authority(sessionId),
      admission: resultFor(initialStatus === 'ready' ? 'ready' : 'blocked'),
      projection: currentProjection(),
      createAdmissionInput: ({
        tasks: _tasks,
        state: _state,
        projectDir: inputProjectDir,
        sessionId: inputSessionId,
      }) =>
        admission(
          inputProjectDir,
          inputSessionId,
          readSpecFile({ projectDir: inputProjectDir, sessionId: inputSessionId }, TASKS_FILE) ??
            '',
        ),
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
    },
    commands,
  };
}

function task(id: string, title = 'Split task') {
  return makeTask({
    id,
    title,
    file: 'src/parser.ts',
    implementationSteps: ['Implement the parser branch.'],
    tests: ['The parser branch is covered.'],
    scope: { inBounds: ['src/parser.ts'] },
    evidence: ['The focused parser test passes.'],
  });
}

describe('reviewAutoSplitOutput', () => {
  it('routes a clean split through admission and controller approval', async () => {
    const projectDir = createTempDir('auto-split-controller-clean');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-clean';
    ensureSessionDir(projectDir, sessionId);
    const initial = baseState();
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn(async () => ({ approved: true as const })),
    });
    const recovery = makeRecovery(sessionId, 'ready', initial, projectDir);
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks, planner: makePlanner() }),
      state: initial,
      tasks: [task('T001')],
      setTrackedState,
      recovery: recovery.binding,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(recovery.commands.map((command) => command.action)).toEqual(['approve']);
  });

  it('enters blocked recovery without an automatic retry and allows conscious rejection', async () => {
    const projectDir = createTempDir('auto-split-controller-reject');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-reject';
    ensureSessionDir(projectDir, sessionId);
    const initial = baseState();
    const { bus } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async () => ({ approved: false as const }));
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const recovery = makeRecovery(sessionId, 'blocked', initial, projectDir);

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state: initial,
      tasks: [task('T001')],
      setTrackedState: vi.fn(),
      recovery: recovery.binding,
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(recovery.commands.map((command) => command.action)).toEqual(['reject']);
  });

  it('routes an explicit edit back through blocked recovery before approval', async () => {
    const projectDir = createTempDir('auto-split-controller-edit');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-edit';
    ensureSessionDir(projectDir, sessionId);
    const initial = baseState();
    const edited = task('T002', 'Edited split task');
    const { bus } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(
      async (_type: 'spec' | 'plan' | 'briefs' | 'artifact', input: ApprovalReviewInput) => {
        if (onApprovalNeeded.mock.calls.length === 1) {
          if (typeof input !== 'string') throw new Error('expected tasks path');
          await writeFile(input, formatTasks([edited]), 'utf8');
          return { approved: false as const, action: 'edit' as const };
        }
        return { approved: true as const };
      },
    );
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const recovery = makeRecovery(sessionId, 'blocked', initial, projectDir);

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state: initial,
      tasks: [task('T001')],
      setTrackedState: vi.fn(),
      recovery: recovery.binding,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    if (result.disposition === 'ready-for-tasks') {
      expect(result.tasks.map((candidate) => candidate.id)).toEqual(['T002']);
    }
    expect(recovery.commands.map((command) => command.action)).toEqual(['edit', 'approve']);
  });

  it('parks without entering the task loop when brief admission fails', async () => {
    const projectDir = createTempDir('auto-split-controller-admission-failure');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-admission-failure';
    ensureSessionDir(projectDir, sessionId);
    const initial = baseState();
    const { bus } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async () => ({ approved: true as const }));
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const implementer = makeImplementer();
    const recovery = makeRecovery(sessionId, 'blocked', initial, projectDir, true);

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks, planner, implementer }),
      state: initial,
      tasks: [task('T001')],
      setTrackedState: vi.fn(),
      recovery: recovery.binding,
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(recovery.commands).toEqual([]);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });
});
