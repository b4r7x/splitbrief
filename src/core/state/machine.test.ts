import { describe, it, expect } from 'vitest';
import { createInitialState, transition } from './machine.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from './selectors.js';
import type { QueuedMessage, WorkflowState } from '../schemas/workflow.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../schemas/brief-owner.js';
import type { RecoveryReceipt } from '../schemas/brief-recovery/attempt.js';
import type {
  NormalBriefRecoveryV1,
  StorageBlockedBriefRecoveryV1,
} from '../schemas/brief-recovery/document.js';
import { taskId } from '../schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

function makeQueuedMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: 'msg-test',
    text: 'queued message',
    queuedAt: '2026-01-01T00:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
    ...overrides,
  };
}

const BRIEF_HASH = 'a'.repeat(64);
const REPORT_HASH = 'b'.repeat(64);

function evidence(
  path: string,
  hash: string = BRIEF_HASH,
): Readonly<{ revision: 1; hash: string; path: string }> {
  return { revision: 1, hash, path };
}

type MatchingReport = NonNullable<NormalBriefRecoveryV1['matchingReport']>;

function makeMatchingReport(overrides: Partial<MatchingReport> = {}): MatchingReport {
  return {
    briefHash: BRIEF_HASH,
    report: evidence('brief-quality.json', REPORT_HASH),
    ruleVersion: 'brief-quality-v1',
    issues: [],
    ...overrides,
  };
}

function makeBriefRecovery(
  status: NormalBriefRecoveryV1['status'] = 'ready',
  overrides: Partial<NormalBriefRecoveryV1> = {},
): NormalBriefRecoveryV1 {
  const activeAttempt: RecoveryReceipt | null =
    status === 'auto-repairing' || status === 'retrying' || status === 'unresolved'
      ? status === 'unresolved'
        ? {
            epochId: 'epoch-1',
            operationId: 'operation-1',
            intentHash: BRIEF_HASH,
            kind: 'manual-retry',
            acceptedAt: '2026-01-01T00:00:00.000Z',
            baseBrief: evidence('tasks.md'),
            baseReport: evidence('brief-quality.json', REPORT_HASH),
            frozenInputIds: [],
            status: 'unresolved',
            dispatchPossibility: 'possible',
            requestId: 'request-1',
            remoteObservation: 'unknown',
            unresolvedAt: '2026-01-01T00:00:00.000Z',
            reservation: {
              accountingKey: {
                sessionId: 'session-1',
                epochId: 'epoch-1',
                operationId: 'operation-1',
                generation: 1,
              },
              amount: 0,
              state: 'held',
              usageApplied: false,
              appliedUsage: null,
              history: [
                {
                  state: 'held',
                  at: '2026-01-01T00:00:00.000Z',
                  reason: 'unresolved',
                },
              ],
            },
          }
        : {
            epochId: 'epoch-1',
            operationId: 'operation-1',
            intentHash: BRIEF_HASH,
            kind: 'manual-retry',
            acceptedAt: '2026-01-01T00:00:00.000Z',
            baseBrief: evidence('tasks.md'),
            baseReport: evidence('brief-quality.json', REPORT_HASH),
            frozenInputIds: [],
            status: 'accepted',
            dispatchPossibility: 'none',
            automaticAllowanceConsumed: true,
            reservation: {
              accountingKey: {
                sessionId: 'session-1',
                epochId: 'epoch-1',
                operationId: 'operation-1',
                generation: 1,
              },
              amount: 0,
              state: 'reserved',
              usageApplied: false,
              appliedUsage: null,
              history: [
                {
                  state: 'reserved',
                  at: '2026-01-01T00:00:00.000Z',
                  reason: 'accepted',
                },
              ],
            },
          }
      : null;
  return {
    version: 1,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: {
      version: 1,
      kind: 'approval',
      mode: 'standard',
      entry: 'initial',
    },
    status,
    activeBrief: evidence('tasks.md'),
    matchingReport: makeMatchingReport(),
    qualityPolicyVersion: 'brief-quality-v1',
    automaticRepair: {
      policy: 'existing-one-shot',
      eligible: true,
      consumed: true,
      operationId: 'operation-1',
    },
    attempts: activeAttempt === null ? {} : { [activeAttempt.operationId]: activeAttempt },
    activeOperationId: activeAttempt?.operationId ?? null,
    inputs: [],
    nextInputSequence: 1,
    noProgress: { fingerprint: null, count: 0 },
    evidenceHead: BRIEF_HASH,
    outbox: [],
    ...overrides,
  };
}

const TEST_GENERATION: BriefGenerationRef = {
  generationId: 'generation-1',
  manifestDigest: 'manifest-1',
  tasksDigest: 'tasks-1',
  qualityDigest: 'quality-1',
  programId: null,
};

function makeExecutionPermit(epochId: string): TaskExecutionPermit {
  return {
    version: 1,
    epochId,
    authorityRevision: 1,
    generationId: TEST_GENERATION.generationId,
    manifestDigest: TEST_GENERATION.manifestDigest,
    tasksDigest: TEST_GENERATION.tasksDigest,
    qualityDigest: TEST_GENERATION.qualityDigest,
    approvalEvidence: evidence('brief-quality.json', REPORT_HASH),
    issuedAt: '2026-01-01T00:00:00.000Z',
  };
}

type OwnerReadyState = WorkflowState & {
  authorityRevision: number;
  generation: BriefGenerationRef;
  permit: TaskExecutionPermit;
  briefRecovery: NormalBriefRecoveryV1;
};

function makeOwnerReadyState(tasks: WorkflowState['tasks'] = []): OwnerReadyState {
  const briefRecovery = makeBriefRecovery();
  const permit = makeExecutionPermit(briefRecovery.epochId);
  return {
    ...createInitialState('feat'),
    phase: 'reviewing-briefs',
    tasks,
    briefRecovery,
    authorityRevision: 1,
    generation: TEST_GENERATION,
    permit,
  };
}

function makeStorageBlockedRecovery(): StorageBlockedBriefRecoveryV1 {
  return {
    version: 1,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: {
      version: 1,
      kind: 'approval',
      mode: 'standard',
      entry: 'initial',
    },
    status: 'storage-blocked',
    activeBrief: null,
    storageEvidence: { code: 'brief_storage_invalid', artifactRef: 'tasks.md' },
    evidenceHead: BRIEF_HASH,
    outbox: [],
  };
}

function expectBriefContractBlocked(run: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    kind: 'brief_contract_blocked',
    data: { reason },
  });
}

function expectPersistedState(state: WorkflowState): void {
  const persisted = WorkflowStateSchema.safeParse({
    ...state,
    stateVersion: 4,
    stateRevision: state.stateRevision ?? 0,
    stateFence: state.stateFence ?? { token: 0, ownerId: 'test-owner' },
    briefRecovery: state.briefRecovery ?? null,
  });
  expect(persisted.success).toBe(true);
}

describe('createInitialState', () => {
  it('returns idle phase with feature set and empty tasks', () => {
    const state = createInitialState('feature');
    expect(state.phase).toBe('idle');
    expect(state.feature).toBe('feature');
    expect(state.tasks).toEqual([]);
  });
});
describe('transition', () => {
  it('throws when an action is not valid for the current phase', () => {
    const state = createInitialState('feat');

    expect(() => transition(state, { type: 'VALIDATION_PASS' })).toThrow(
      'Cannot apply VALIDATION_PASS',
    );
  });

  it('does not expose a legacy direct path into implementation', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state = createInitialState('feat');
    const legacyActions = [
      { type: 'START_QUICK', tasks },
      { type: 'START_INSTANT', tasks },
    ] as const;

    for (const action of legacyActions) {
      expect(() => transition(state, action as never)).toThrow(
        `Cannot apply ${action.type} while workflow is in idle.`,
      );
    }
  });

  it('REJECT_SPEC -> idle', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-spec',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'REJECT_SPEC' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('VALIDATION_FAIL with attempt < 3 -> implementing with attempt incremented', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 1,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' });
    expect(next.phase).toBe('implementing');
    expect(next.attempt).toBe(2);
  });

  it('ESCALATE -> escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
    };
    const next = transition(state, { type: 'ESCALATE' });
    expect(next.phase).toBe('escalating');
  });

  it('VALIDATION_FAIL is rejected from implementing phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    expect(() => transition(state, { type: 'VALIDATION_FAIL' })).toThrow(
      'Cannot apply VALIDATION_FAIL',
    );
  });

  it('ESCALATE is rejected from implementing phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    expect(() => transition(state, { type: 'ESCALATE' })).toThrow('Cannot apply ESCALATE');
  });

  it('HINT_SUCCESS -> implementing with index advanced', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(getCompletedTaskIds(next)).toEqual([]);
    expect(getEscalatedTaskIds(next)).toEqual(['T001']);
  });

  it('HINT_SUCCESS is accepted from implementing for escalated retry completions', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });

    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(getCompletedTaskIds(next)).toEqual([]);
    expect(getEscalatedTaskIds(next)).toEqual(['T001']);
  });

  it('CANCEL -> idle with tasks cleared and counters reset', () => {
    const tasks = [makeTask({ id: 'T000', status: 'done' }), makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'CANCEL' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
    expect(next.feature).toBe('feat');
  });

  it('CANCEL clears awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'CANCEL' });
    expect(next.awaitingContinue).toBe(false);
  });

  it('ABORT_TURN sets awaitingContinue to true', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(state, { type: 'ABORT_TURN' });
    expect(next.awaitingContinue).toBe(true);
    expect(next.phase).toBe('implementing');
  });

  it('CONTINUE_TURN clears awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'CONTINUE_TURN' });
    expect(next.awaitingContinue).toBe(false);
    expect(next.phase).toBe('implementing');
  });

  it('CLEAR_QUEUE removes only messages still pending delivery', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      messageQueue: [
        makeQueuedMessage({ id: 'msg-pending' }),
        makeQueuedMessage({ id: 'msg-injecting', nativeDeliveryState: 'injecting' }),
        makeQueuedMessage({ id: 'msg-native', deliveredViaNative: true }),
        makeQueuedMessage({
          id: 'msg-drained',
          drainedAt: '2026-01-01T00:00:01.000Z',
        }),
      ],
    };

    const next = transition(state, { type: 'CLEAR_QUEUE' });

    expect(next.messageQueue.map((message) => message.id)).toEqual(['msg-native', 'msg-drained']);
  });

  it('REJECT_PLAN -> idle', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-plan',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'REJECT_PLAN' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('HINT_FAIL -> stays in escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
    };
    const next = transition(state, { type: 'HINT_FAIL' });
    expect(next.phase).toBe('escalating');
  });

  it('FULL_SUCCESS -> implementing with index advanced, task in escalatedTasks, attempt reset', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'FULL_SUCCESS' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(getEscalatedTaskIds(next)).toEqual(['T001']);
    expect(next.attempt).toBe(0);
  });

  it('SET_PLANNER_SESSION_ID overwrites existing plannerSessionId', () => {
    let state = createInitialState('feat');
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'first' });
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'second' });
    expect(state.plannerSessionId).toBe('second');
  });

  it('a re-entered task at attempt 2 of maxRetries 3 escalates after one local VALIDATION_FAIL', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const resumed: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 2,
    };
    const started = transition(resumed, { type: 'START_TASK', taskId: tasks[0]!.id });
    expect(started.attempt).toBe(2);
    expect(started.tasks[0]?.status).toBe('in_progress');

    const sent = transition(started, { type: 'TASK_SENT' });
    const failed = transition(sent, { type: 'VALIDATION_FAIL' });
    expect(failed.phase).toBe('implementing');
    expect(failed.attempt).toBe(3);

    const sentAgain = transition(failed, { type: 'TASK_SENT' });
    const exhausted = transition(sentAgain, { type: 'VALIDATION_FAIL' });
    expect(exhausted.phase).toBe('escalating');
  });

  it('CLEAR_TASK_CODE removes stale currentCode from the selected task only', () => {
    const tasks = [
      makeTask({ id: 'T001', currentCode: 'stale code' }),
      makeTask({ id: 'T002', currentCode: 'keep code' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
    };

    const next = transition(state, { type: 'CLEAR_TASK_CODE', taskId: tasks[0]!.id });

    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[1]?.currentCode).toBe('keep code');
  });

  it('configurable maxRetries: attempt < custom max stays in implementing', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 4,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' }, { maxRetries: 5 });
    expect(next.phase).toBe('implementing');
    expect(next.attempt).toBe(5);
  });

  it('configurable maxRetries: attempt >= custom max transitions to escalating', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 5,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' }, { maxRetries: 5 });
    expect(next.phase).toBe('escalating');
  });

  it('VALIDATION_FAIL at default max transitions to escalating', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' });
    expect(next.phase).toBe('escalating');
  });

  it('full workflow: START through REVIEW_DONE', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];

    let s = createInitialState('full-flow');
    expect(s.phase).toBe('idle');

    s = transition(s, { type: 'START' });
    expect(s.phase).toBe('researching');

    s = transition(s, { type: 'RESEARCH_DONE' });
    expect(s.phase).toBe('specifying');

    s = transition(s, { type: 'SPEC_DONE' });
    expect(s.phase).toBe('reviewing-spec');

    s = transition(s, { type: 'APPROVE_SPEC' });
    expect(s.phase).toBe('planning');

    s = transition(s, { type: 'PLAN_DONE', tasks });
    expect(s.phase).toBe('reviewing-plan');
    expect(s.tasks).toEqual(tasks);

    s = transition(s, {
      type: 'BRIEF_ADMISSION_OPENED',
      briefRecovery: makeBriefRecovery(),
    });
    const permit = makeExecutionPermit('epoch-1');
    s = {
      ...s,
      authorityRevision: 1,
      generation: TEST_GENERATION,
      permit,
    };
    expect(s.phase).toBe('reviewing-briefs');
    s = transition(s, {
      type: 'BEGIN_IMPLEMENTATION',
      generation: TEST_GENERATION,
      permit,
    });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(0);

    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(1);
    expect(getCompletedTaskIds(s)).toEqual(['T001']);

    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(2);
    expect(getCompletedTaskIds(s)).toEqual(['T001', 'T002']);

    s = transition(s, { type: 'ALL_DONE' });
    expect(s.phase).toBe('final-review');

    s = transition(s, { type: 'REVIEW_DONE' });
    expect(s.phase).toBe('complete');

    expect(s.feature).toBe('full-flow');
    expect(getCompletedTaskIds(s)).toEqual(['T001', 'T002']);
    expect(getFailedTaskIds(s)).toEqual([]);
    expect(getEscalatedTaskIds(s)).toEqual([]);
    expect(getSkippedTaskIds(s)).toEqual([]);
    expect(s.currentTaskIndex).toBe(2);
  });

  it.each([
    ['REWIND_TO_SPEC', 'specifying'],
    ['REWIND_TO_PLAN', 'planning'],
  ] as const)('%s -> %s with tasks cleared and counters reset', (type, phase) => {
    const tasks = [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
      awaitingContinue: true,
      plannerSessionId: 'old-session',
      discoveredValidation: { testCommand: 'npm test' },
    };
    const next = transition(state, { type });
    expect(next.phase).toBe(phase);
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
    expect(next.awaitingContinue).toBe(false);
    expect(next.plannerSessionId).toBeUndefined();
    expect(next.discoveredValidation).toBeUndefined();
  });

  it('RESET_TASK -> implementing with task set to pending and index rewound', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 2,
      attempt: 1,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: tasks[1]!.id });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(next.tasks[1]?.status).toBe('pending');
    expect(next.tasks[0]?.status).toBe('done');
  });

  it('RESET_TASK with unknown taskId returns state unchanged', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: taskId('T999') });
    expect(next).toBe(state);
  });

  it.each([
    ['REWIND_TO_SPEC', 'specifying', 'spec', 'use refresh tokens'],
    ['REWIND_TO_PLAN', 'planning', 'plan', 'add caching layer'],
  ] as const)('%s with comment sets rewindPending', (type, phase, target, comment) => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type, comment });
    expect(next.phase).toBe(phase);
    expect(next.rewindPending).toEqual({ target, comment });
  });

  it('REWIND_TO_SPEC without comment sets rewindPending with no comment field', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'REWIND_TO_SPEC' });
    expect(next.phase).toBe('specifying');
    expect(next.rewindPending).toEqual({ target: 'spec' });
    expect(next.rewindPending?.comment).toBeUndefined();
  });

  it('RESET_TASK does NOT set rewindPending', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: tasks[0]!.id });
    expect(next.rewindPending).toBeUndefined();
  });

  it('CLEAR_REWIND_PENDING clears the field', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'specifying',
      rewindPending: { target: 'spec', comment: 'foo' },
    };
    const next = transition(state, { type: 'CLEAR_REWIND_PENDING' });
    expect(next.rewindPending).toBeUndefined();
    expect(next.phase).toBe('specifying');
  });

  it('SPEC_CLARIFY_START -> clarifying', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-spec' };
    const next = transition(state, { type: 'SPEC_CLARIFY_START' });
    expect(next.phase).toBe('clarifying');
  });

  it('SPEC_CLARIFY_DONE -> constitution-check', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'clarifying' };
    const next = transition(state, { type: 'SPEC_CLARIFY_DONE' });
    expect(next.phase).toBe('constitution-check');
  });

  it('CONSTITUTION_CHECK_PASS -> planning', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'constitution-check' };
    const next = transition(state, { type: 'CONSTITUTION_CHECK_PASS' });
    expect(next.phase).toBe('planning');
  });

  it('CONSTITUTION_CHECK_FAIL -> idle and clears awaitingContinue', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'constitution-check',
      awaitingContinue: true,
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, {
      type: 'CONSTITUTION_CHECK_FAIL',
    });
    expect(next.phase).toBe('idle');
    expect(next.awaitingContinue).toBe(false);
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('ANALYZE_START -> analyzing', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'ANALYZE_START' });
    expect(next.phase).toBe('analyzing');
  });

  it('does not leave analyzing through a legacy implementation transition', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'analyzing' };
    expect(() => transition(state, { type: 'ANALYZE_DONE' } as never)).toThrow(
      'Cannot apply ANALYZE_DONE while workflow is in analyzing.',
    );
  });

  it('BEGIN_IMPLEMENTATION enters implementation with the exact persisted owner permit', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state = {
      ...makeOwnerReadyState(tasks),
      currentTaskIndex: 3,
      attempt: 2,
    };
    const next = transition(state, {
      type: 'BEGIN_IMPLEMENTATION',
      generation: TEST_GENERATION,
      permit: state.permit,
    });
    expect(next.phase).toBe('implementing');
    expect(next.tasks).toEqual(tasks);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
    expect(next.generation).toEqual(TEST_GENERATION);
    expect(next.permit).toEqual(state.permit);
    expect(next.briefRecovery?.status).toBe('ready');
  });

  it('keeps readiness-blocked out of implementation until the persisted recovery is ready', () => {
    const initial: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: makeBriefRecovery('ready'),
    };
    const blockedDecision = {
      kind: 'blocked' as const,
      fingerprint: 'c'.repeat(64),
      briefHash: BRIEF_HASH,
      reportHash: REPORT_HASH,
      qualityPolicyVersion: 'brief-quality-v1',
    };
    const state = transition(initial, {
      type: 'RECORD_BRIEF_READINESS',
      decision: blockedDecision,
    });
    expect(state.briefRecovery).toMatchObject({
      status: 'readiness-blocked',
      readinessDecision: blockedDecision,
    });
    expectPersistedState(state);

    let caught: unknown;
    try {
      transition(state, {
        type: 'BEGIN_IMPLEMENTATION',
        generation: TEST_GENERATION,
        permit: makeExecutionPermit('epoch-1'),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      kind: 'brief_readiness_blocked',
      data: { epochId: 'epoch-1' },
    });

    const overridden = transition(state, {
      type: 'RECORD_BRIEF_READINESS',
      decision: { ...blockedDecision, kind: 'override' },
    });
    expect(overridden.briefRecovery).toMatchObject({
      status: 'ready',
      readinessDecision: { ...blockedDecision, kind: 'override' },
    });
    expectPersistedState(overridden);
    const permit = makeExecutionPermit('epoch-1');
    const ownerReady = {
      ...overridden,
      authorityRevision: 1,
      generation: TEST_GENERATION,
      permit,
    };
    expect(
      transition(ownerReady, {
        type: 'BEGIN_IMPLEMENTATION',
        generation: TEST_GENERATION,
        permit,
      }).phase,
    ).toBe('implementing');
  });

  it.each(['passed', 'override'] as const)(
    'rejects an unvalidated %s readiness decision',
    (kind) => {
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase: 'reviewing-briefs',
        briefRecovery: makeBriefRecovery('readiness-blocked'),
      };

      expect(() =>
        transition(state, {
          type: 'RECORD_BRIEF_READINESS',
          decision: {
            kind,
            fingerprint: 'c'.repeat(64),
            briefHash: BRIEF_HASH,
            reportHash: REPORT_HASH,
            qualityPolicyVersion: 'brief-quality-v1',
          },
        }),
      ).toThrow('readiness must be re-evaluated or explicitly overridden');
    },
  );

  it('keeps warning-only quality issues non-blocking', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: makeBriefRecovery('ready', {
        matchingReport: makeMatchingReport({
          issues: [
            {
              code: 'readiness_hint',
              severity: 'warning',
              taskId: null,
              message: 'A readiness hint is available.',
            },
          ],
        }),
      }),
    };

    const ownerState = {
      ...state,
      authorityRevision: 1,
      generation: TEST_GENERATION,
      permit: makeExecutionPermit(state.briefRecovery?.epochId ?? 'missing'),
    };
    expect(
      transition(ownerState, {
        type: 'BEGIN_IMPLEMENTATION',
        generation: TEST_GENERATION,
        permit: ownerState.permit,
      }).phase,
    ).toBe('implementing');
  });

  it.each([
    ['checking', makeBriefRecovery('checking'), 'not-ready'],
    ['auto-repairing', makeBriefRecovery('auto-repairing'), 'retry-in-flight'],
    [
      'quality errors',
      makeBriefRecovery('blocked', {
        matchingReport: makeMatchingReport({
          issues: [
            {
              code: 'missing_steps',
              severity: 'error',
              taskId: 'T001',
              message: 'Implementation steps are missing.',
            },
          ],
        }),
      }),
      'quality-errors',
    ],
    [
      'stale report',
      makeBriefRecovery('ready', {
        matchingReport: makeMatchingReport({ briefHash: REPORT_HASH }),
      }),
      'stale-report',
    ],
    ['retrying', makeBriefRecovery('retrying'), 'retry-in-flight'],
    ['unresolved', makeBriefRecovery('unresolved'), 'unresolved-retry'],
    ['storage blocked', makeStorageBlockedRecovery(), 'not-ready'],
  ] as const)(
    'blocks %s from BEGIN_IMPLEMENTATION with brief_contract_blocked',
    (_label, briefRecovery, reason) => {
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase: 'reviewing-briefs',
        briefRecovery,
      };

      const before = structuredClone(state);
      expectBriefContractBlocked(
        () =>
          transition(state, {
            type: 'BEGIN_IMPLEMENTATION',
            generation: TEST_GENERATION,
            permit: makeExecutionPermit(briefRecovery.epochId),
          }),
        reason,
      );
      expect(state).toEqual(before);
    },
  );

  it('opens each non-terminal recovery status under reviewing-briefs', () => {
    const statuses = [
      'checking',
      'auto-repairing',
      'blocked',
      'retrying',
      'unresolved',
      'ready',
      'readiness-blocked',
    ] as const;

    for (const status of statuses) {
      const recovery = makeBriefRecovery(status);
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase: 'reviewing-plan',
      };
      const next = transition(state, {
        type: 'BRIEF_ADMISSION_OPENED',
        briefRecovery: recovery,
      });
      expect(next.phase).toBe('reviewing-briefs');
      expect(next.briefRecovery).toEqual(recovery);
      expectPersistedState(next);
    }
  });

  it('rejects a stale recovery epoch and a rejected archive cannot reopen', () => {
    const current = makeBriefRecovery();
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: current,
    };

    expectBriefContractBlocked(
      () =>
        transition(state, {
          type: 'BRIEF_ADMISSION_OPENED',
          briefRecovery: { ...current, epochId: 'epoch-2' },
        }),
      'stale-report',
    );

    const rejected = transition(state, { type: 'REJECT_BRIEFS' });
    expect(rejected.phase).toBe('idle');
    expect(rejected.briefRecovery?.status).toBe('rejected');

    expect(() =>
      transition(rejected, {
        type: 'BEGIN_IMPLEMENTATION',
        generation: TEST_GENERATION,
        permit: makeExecutionPermit(current.epochId),
      }),
    ).toThrow('Cannot apply BEGIN_IMPLEMENTATION');
    expect(() =>
      transition(rejected, {
        type: 'BRIEF_ADMISSION_OPENED',
        briefRecovery: current,
      }),
    ).toThrow('Cannot apply BRIEF_ADMISSION_OPENED');
  });

  it('REJECT_BRIEFS leaves an action-free archive until new workflow initialization', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      tasks: [makeTask({ id: 'T001' })],
      currentTaskIndex: 1,
      attempt: 2,
      briefRecovery: makeBriefRecovery('blocked'),
    };

    const rejected = transition(state, { type: 'REJECT_BRIEFS' });
    expect(rejected).toMatchObject({
      phase: 'idle',
      tasks: [],
      currentTaskIndex: 0,
      attempt: 0,
      briefRecovery: { status: 'rejected', activeOperationId: null },
    });

    const restarted = transition(rejected, { type: 'START' });
    expect(restarted.phase).toBe('researching');
    expect(restarted.briefRecovery).toBeNull();
  });

  it.each([
    'checking',
    'auto-repairing',
    'blocked',
    'retrying',
    'unresolved',
    'ready',
    'readiness-blocked',
    'rejected',
  ] as const)(
    'REJECT_BRIEFS round-trips a legal %s recovery through the persisted schema',
    (status) => {
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase: 'reviewing-briefs',
        briefRecovery: makeBriefRecovery(status),
      };

      const rejected = transition(state, { type: 'REJECT_BRIEFS' });

      expect(rejected.phase).toBe('idle');
      expect(rejected.briefRecovery?.status).toBe('rejected');
      expectPersistedState(rejected);
    },
  );

  it('REJECT_BRIEFS converts storage-blocked recovery to a null-Brief rejected archive', () => {
    const storageEvidence = {
      code: 'brief_storage_invalid' as const,
      artifactRef: 'tasks.md',
    };
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: { ...makeStorageBlockedRecovery(), storageEvidence },
    };

    const rejected = transition(state, { type: 'REJECT_BRIEFS' });

    expect(rejected).toMatchObject({
      phase: 'idle',
      briefRecovery: {
        status: 'rejected',
        activeBrief: null,
        storageEvidence,
      },
    });
    expectPersistedState(rejected);
    const parsed = WorkflowStateSchema.parse({
      ...rejected,
      stateRevision: rejected.stateRevision ?? 0,
      stateFence: rejected.stateFence ?? { token: 0, ownerId: 'test-owner' },
      briefRecovery: rejected.briefRecovery ?? null,
    });
    expect(parsed.briefRecovery).toMatchObject({ activeBrief: null, storageEvidence });
  });

  it.each([
    'checking',
    'auto-repairing',
    'blocked',
    'retrying',
    'unresolved',
    'ready',
    'readiness-blocked',
  ] as const)('CANCEL clears non-terminal %s recovery before entering idle', (status) => {
    const next = transition(
      {
        ...createInitialState('feat'),
        phase: 'reviewing-briefs',
        briefRecovery: makeBriefRecovery(status),
      },
      { type: 'CANCEL' },
    );

    expect(next.briefRecovery).toBeNull();
    expectPersistedState(next);
  });

  it('BEGIN_IMPLEMENTATION -> implementing with index and attempt reset', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state = makeOwnerReadyState(tasks);
    const next = transition(state, {
      type: 'BEGIN_IMPLEMENTATION',
      generation: state.generation,
      permit: state.permit,
    });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('REJECT_BRIEFS -> idle', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      tasks,
      briefRecovery: makeBriefRecovery('blocked'),
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'REJECT_BRIEFS' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it.each([null, undefined] as const)(
    'BEGIN_IMPLEMENTATION fails closed when the current recovery proof is %s',
    (missing) => {
      const initial = createInitialState('feat');
      const state: WorkflowState = {
        ...initial,
        phase: 'reviewing-briefs',
        ...(missing === undefined ? {} : { briefRecovery: null }),
      };
      expectBriefContractBlocked(
        () =>
          transition(state, {
            type: 'BEGIN_IMPLEMENTATION',
            generation: TEST_GENERATION,
            permit: makeExecutionPermit('epoch-1'),
          }),
        'missing-recovery',
      );
    },
  );

  it('rejects stale, missing, and mismatched owner permits', () => {
    const state = makeOwnerReadyState([makeTask({ id: 'T001' })]);
    const action = {
      type: 'BEGIN_IMPLEMENTATION' as const,
      generation: TEST_GENERATION,
      permit: state.permit,
    };
    expect(transition(state, action).phase).toBe('implementing');
    expect(() =>
      transition(state, {
        ...action,
        permit: { ...action.permit, authorityRevision: 2 },
      }),
    ).toThrow('exact current owner-issued generation and execution permit');
    expect(() => transition({ ...state, permit: null }, action)).toThrow(
      'exact current owner-issued generation and execution permit',
    );
    expect(() =>
      transition(state, {
        ...action,
        generation: { ...TEST_GENERATION, tasksDigest: 'tasks-2' },
      }),
    ).toThrow('exact current owner-issued generation and execution permit');
  });

  it('BEGIN_IMPLEMENTATION round-trips the ready legal path through the persisted schema', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state = makeOwnerReadyState(tasks);
    expectPersistedState(state);
    const next = transition(state, {
      type: 'BEGIN_IMPLEMENTATION',
      generation: state.generation,
      permit: state.permit,
    });
    expectPersistedState(next);
    expect(next.phase).toBe('implementing');
    expect(next.briefRecovery?.status).toBe('ready');
  });

  it('BRIEF_ADMISSION_OPENED round-trips a storage-blocked recovery', () => {
    const storage = transition(
      { ...createInitialState('feat'), phase: 'reviewing-plan' },
      { type: 'BRIEF_ADMISSION_OPENED', briefRecovery: makeStorageBlockedRecovery() },
    );
    expectPersistedState(storage);
  });

  it('blocks an otherwise clean report whose rule identity is stale', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: makeBriefRecovery('ready', {
        matchingReport: makeMatchingReport({ ruleVersion: 'brief-quality-v0' }),
      }),
    };

    expectBriefContractBlocked(
      () =>
        transition(state, {
          type: 'BEGIN_IMPLEMENTATION',
          generation: TEST_GENERATION,
          permit: makeExecutionPermit(state.briefRecovery?.epochId ?? 'missing'),
        }),
      'stale-report',
    );
  });

  it('blocks a ready report carrying an attempt from another epoch', () => {
    const current = makeBriefRecovery('ready', {
      attempts: {
        'operation-1': {
          epochId: 'epoch-2',
          operationId: 'operation-1',
          intentHash: BRIEF_HASH,
          kind: 'manual-retry',
          acceptedAt: '2026-01-01T00:00:00.000Z',
          baseBrief: evidence('tasks.md'),
          baseReport: evidence('brief-quality.json', REPORT_HASH),
          frozenInputIds: [],
          status: 'settled',
          dispatchPossibility: 'none',
          remoteObservation: 'not-dispatched',
          resultId: 'result-1',
          outcome: 'quality-failed',
          providerCode: null,
          usage: null,
          settledAt: '2026-01-01T00:00:00.000Z',
          candidate: null,
          report: null,
          reservation: {
            accountingKey: {
              sessionId: 'session-1',
              epochId: 'epoch-2',
              operationId: 'operation-1',
              generation: 1,
            },
            amount: 0,
            state: 'released',
            usageApplied: false,
            appliedUsage: null,
            history: [{ state: 'released', at: '2026-01-01T00:00:00.000Z', reason: 'superseded' }],
          },
        },
      },
    });
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      briefRecovery: current,
    };

    expectBriefContractBlocked(
      () =>
        transition(state, {
          type: 'BEGIN_IMPLEMENTATION',
          generation: TEST_GENERATION,
          permit: makeExecutionPermit(current.epochId),
        }),
      'stale-report',
    );
  });

  it('SET_PENDING_RECOVERY stores recovery overlay without changing phase', () => {
    const issue = makeRecoveryIssue();
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'validating-task' };

    const next = transition(state, { type: 'SET_PENDING_RECOVERY', issue });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery).toEqual(issue);
  });

  it('PAUSE_PENDING_RECOVERY marks pending recovery as paused', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue(),
    };

    const next = transition(state, { type: 'PAUSE_PENDING_RECOVERY' });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery?.status).toBe('paused');
  });

  it('MARK_RECOVERY_APPLYING records selected action while keeping recovery pending', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue(),
    };

    const next = transition(state, {
      type: 'MARK_RECOVERY_APPLYING',
      action: 'route-bigger-worker',
    });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery?.status).toBe('applying');
    expect(next.pendingRecovery?.selectedAction).toBe('route-bigger-worker');
  });

  it('MARK_RECOVERY_APPLYING replaces a stale paused action for replay', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue({
        status: 'paused',
        selectedAction: 'pause-run',
      }),
    };

    const next = transition(state, {
      type: 'MARK_RECOVERY_APPLYING',
      action: 'retry-same-worker',
    });

    expect(next.pendingRecovery?.status).toBe('applying');
    expect(next.pendingRecovery?.selectedAction).toBe('retry-same-worker');
  });

  it('RESOLVE_PENDING_RECOVERY clears pending recovery after a selected action succeeds', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue({
        status: 'applying',
        selectedAction: 'retry-same-worker',
      }),
    };

    const next = transition(state, {
      type: 'RESOLVE_PENDING_RECOVERY',
    });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery).toBeUndefined();
  });

  it('TASK_SENT strips currentCode from the sent task', () => {
    const tasks = [makeTask({ id: 'T001', currentCode: 'const x = 1;' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'TASK_SENT' });
    expect(next.phase).toBe('validating-task');
    expect(next.tasks[0]?.currentCode).toBeUndefined();
  });

  it('VALIDATION_PASS strips currentCode from the completed task', () => {
    const tasks = [makeTask({ id: 'T001', currentCode: 'const x = 1;' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'VALIDATION_PASS' });
    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[0]?.status).toBe('done');
  });

  it('SKIP_TASK -> implementing with attempt reset and index advanced', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 2,
    };
    const next = transition(state, { type: 'SKIP_TASK', taskId: tasks[0]!.id });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(getSkippedTaskIds(next)).toEqual(['T001']);
  });

  it('FULL_SUCCESS strips currentCode from the escalated task', () => {
    const tasks = [
      makeTask({ id: 'T001', currentCode: 'source code here' }),
      makeTask({ id: 'T002' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'FULL_SUCCESS' });
    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[0]?.status).toBe('escalated');
  });
});
