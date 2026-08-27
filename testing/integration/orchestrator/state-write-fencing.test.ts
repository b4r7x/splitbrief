import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  confinedAtomicWriteFileSync,
  confinedAtomicWriteFileSyncForTest,
  type ConfinedAtomicWriteSyncTestOperations,
} from '../../../src/lib/confined-fs-atomic.js';
import { SECURE_FILE_MODE } from '../../../src/lib/fs.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { STATE_FILE, stateAuthorityDirectory, sessionDir } from '../../../src/core/paths.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import type {
  ResumeLoadAuthority,
  StateAction,
  StateAuthorityAcquisitionResult,
  StateAuthorityReceipt,
} from '../../../src/core/state/types.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadState, loadStateForResume, saveState } from '../../../src/core/state/persistence.js';
import {
  acquireStateAuthority,
  readStateAuthority,
  releaseStateAuthority,
} from '../../../src/core/state/authority.js';
import { addUsageAndSave, transitionAndSave } from '../../../src/engine/orchestrator/state-ops.js';
import {
  WorkflowStateSchema,
  type QueuedMessage,
  type WorkflowState,
} from '../../../src/core/schemas/workflow.js';
import { taskId } from '../../../src/core/schemas/task.js';

type Fixture = Readonly<{
  projectDir: string;
  ref: { projectDir: string; sessionId: string };
}>;

const fixtures: string[] = [];

function fixture(prefix = 'state-write-fencing'): Fixture {
  const projectDir = createTempDir(prefix);
  const sessionId = 'session-1';
  ensureSessionDir(projectDir, sessionId);
  fixtures.push(projectDir);
  return { projectDir, ref: { projectDir, sessionId } };
}

afterEach(() => {
  for (const projectDir of fixtures.splice(0)) cleanupTempDir(projectDir);
});

function queuedMessage(id: string, text = id): QueuedMessage {
  return {
    id,
    text,
    queuedAt: '2026-08-13T00:00:00.000Z',
    phase: 'implementing',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  };
}

function legacyState(feature = 'legacy-feature'): WorkflowState {
  return {
    ...createInitialState(feature),
    stateVersion: 3,
    phase: 'reviewing-briefs',
    currentTaskIndex: 0,
    tasks: [],
    mode: 'standard',
    messageQueue: [],
  };
}

function fenced(
  result: StateAuthorityAcquisitionResult,
): Extract<StateAuthorityAcquisitionResult, { kind: 'fenced' }> {
  if (result.kind !== 'fenced') {
    throw new Error(`Expected fenced authority, got ${result.kind}.`);
  }
  return result;
}

function seedFencedState(
  value: WorkflowState = createInitialState('fenced-feature'),
  ownerId = 'owner-a',
): Fixture & {
  authority: StateAuthorityReceipt;
  state: WorkflowState;
} {
  const result = fixture();
  saveState(result.ref, value);
  const acquired = fenced(
    acquireStateAuthority({
      ref: result.ref,
      purpose: 'resume',
      ownerId,
      runId: `${ownerId}-run`,
      acquisitionId: `${ownerId}-acquisition`,
    }),
  );
  const loaded = loadStateForResume({ ref: result.ref, authority: acquired });
  if (loaded.kind !== 'loaded')
    throw new Error(`Expected fenced state to load, got ${loaded.kind}.`);
  return { ...result, authority: acquired.receipt, state: loaded.state };
}

function mutationOptions(
  state: WorkflowState,
  authority: StateAuthorityReceipt,
  conflictRetries = 0,
) {
  return {
    expectedRevision: state.stateRevision,
    authority,
    conflictRetries,
  };
}

function assertValidHead(
  ref: Fixture['ref'],
  expectedRevision: number,
  expectedFence: number,
  expectedOwner: string,
): WorkflowState {
  const state = loadState(ref);
  expect(state).not.toBeNull();
  if (state === null) throw new Error('Expected a persisted workflow state.');
  expect(WorkflowStateSchema.safeParse(state).success).toBe(true);
  expect(state.stateRevision).toBe(expectedRevision);
  expect(state.stateFence).toEqual({ token: expectedFence, ownerId: expectedOwner });
  return state;
}

describe('global state writer fencing', () => {
  it('keeps one fenced head across the migrated writer-path matrix', () => {
    const task = makeTask({ id: taskId('T001') });
    const { ref, authority, state: initial } = seedFencedState();
    const bus = createEventBus();
    let state = initial;
    const writerActions: readonly Readonly<{ writer: string; action: StateAction }>[] = [
      { writer: 'startup', action: { type: 'START' } },
      { writer: 'IPC workflow loop', action: { type: 'RESEARCH_DONE' } },
      { writer: 'local TUI rewind', action: { type: 'REWIND_TO_PLAN', comment: 'rebase plan' } },
      { writer: 'planning', action: { type: 'PLAN_DONE', tasks: [task] } },
      { writer: 'queue', action: { type: 'ENQUEUE_USER_MSG', message: queuedMessage('queued-1') } },
      { writer: 'queue drain', action: { type: 'DRAIN_QUEUE' } },
      { writer: 'cancellation', action: { type: 'CANCEL' } },
      { writer: 'startup', action: { type: 'RESEARCH_DONE' } },
      { writer: 'planning', action: { type: 'SPEC_DONE' } },
      {
        writer: 'escalation',
        action: { type: 'SET_PENDING_RECOVERY', issue: makeRecoveryIssue() },
      },
      { writer: 'shutdown', action: { type: 'CANCEL' } },
    ];

    for (const { writer, action } of writerActions) {
      const previousRevision = state.stateRevision ?? 0;
      state = transitionAndSave(ref, state, action, mutationOptions(state, authority));
      expect(state.stateRevision, `${writer} revision`).toBe(previousRevision + 1);
      expect(state.stateFence, `${writer} fence`).toEqual({
        token: authority.fence,
        ownerId: authority.ownerId,
      });
      assertValidHead(ref, previousRevision + 1, authority.fence, authority.ownerId);
    }

    const previousRevision = state.stateRevision ?? 0;
    state = addUsageAndSave(
      { ...ref, bus },
      state,
      'planner',
      { inputTokens: 11, outputTokens: 7 },
      mutationOptions(state, authority),
    );
    expect(state.stateRevision).toBe(previousRevision + 1);
    expect(state.tokenUsage.plannerInput).toBe(11);
    expect(state.tokenUsage.plannerOutput).toBe(7);
    assertValidHead(ref, previousRevision + 1, authority.fence, authority.ownerId);

    const ownerPath = join(stateAuthorityDirectory(ref), 'owner.json');
    const ownerRecord = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
      kind: string;
      ownerId: string;
      fence: number;
    };
    expect(ownerRecord).toMatchObject({
      kind: 'usable',
      ownerId: authority.ownerId,
      fence: authority.fence,
    });
    expect(readStateAuthority(ref)).toMatchObject({
      ownerId: authority.ownerId,
      fence: authority.fence,
    });
  });

  it('rebases stale concurrent queue and usage writers into one valid head', async () => {
    const { ref, authority, state: stale } = seedFencedState();
    const bus = createEventBus();
    const options = mutationOptions(stale, authority, 1);

    const [queued, booked] = await Promise.all([
      Promise.resolve().then(() =>
        transitionAndSave(
          ref,
          stale,
          {
            type: 'ENQUEUE_USER_MSG',
            message: queuedMessage('queued-1'),
          },
          options,
        ),
      ),
      Promise.resolve().then(() =>
        addUsageAndSave(
          { ...ref, bus },
          stale,
          'planner',
          { inputTokens: 13, outputTokens: 5 },
          options,
        ),
      ),
    ]);

    expect(queued.stateFence).toEqual(booked.stateFence);
    const latest = loadState(ref);
    expect(latest).not.toBeNull();
    if (latest === null) throw new Error('Expected a concurrent writer head.');
    expect(latest.messageQueue.map((message) => message.id)).toEqual(['queued-1']);
    expect(latest.tokenUsage).toMatchObject({ plannerInput: 13, plannerOutput: 5 });
    expect(latest.stateRevision).toBe((stale.stateRevision ?? 0) + 2);

    const secondInput = transitionAndSave(
      ref,
      stale,
      { type: 'ENQUEUE_USER_MSG', message: queuedMessage('queued-2') },
      options,
    );
    expect(secondInput.messageQueue.map((message) => message.id)).toEqual(['queued-1', 'queued-2']);
    const final = assertValidHead(
      ref,
      (stale.stateRevision ?? 0) + 3,
      authority.fence,
      authority.ownerId,
    );
    expect(final.messageQueue.map((message) => message.id)).toEqual(['queued-1', 'queued-2']);
    expect(final.tokenUsage).toMatchObject({ plannerInput: 13, plannerOutput: 5 });
  });

  it('refuses a live owner and fences a proven-dead takeover against stale mutation and unlock', () => {
    const first = seedFencedState();
    expect(() =>
      acquireStateAuthority({
        ref: first.ref,
        purpose: 'resume',
        ownerId: 'owner-b',
        runId: 'owner-b-run',
        acquisitionId: 'owner-b-acquisition',
      }),
    ).toThrow(/live|proven dead/iu);

    const old = seedFencedState(createInitialState('takeover-feature'), 'old-owner');
    const oldDir = stateAuthorityDirectory(old.ref);
    const oldOwnerRecord = JSON.parse(readFileSync(join(oldDir, 'owner.json'), 'utf8')) as {
      ownerId: string;
    };
    expect(oldOwnerRecord.ownerId).toBe('old-owner');

    cleanupTempDir(first.projectDir);
    fixtures.splice(fixtures.indexOf(first.projectDir), 1);

    const dead = fixture('state-write-fencing-dead');
    saveState(dead.ref, createInitialState('dead-owner-feature'));
    const oldAuthority = fenced(
      acquireStateAuthority({
        ref: dead.ref,
        purpose: 'resume',
        ownerId: 'dead-owner',
        runId: 'dead-run',
        acquisitionId: 'dead-acquisition',
        pid: 2_147_483_646,
        processStart: '1',
      }),
    );
    const successor = fenced(
      acquireStateAuthority({
        ref: dead.ref,
        purpose: 'resume',
        ownerId: 'successor-owner',
        runId: 'successor-run',
        acquisitionId: 'successor-acquisition',
      }),
    );
    expect(successor.receipt.fence).toBeGreaterThan(oldAuthority.receipt.fence);
    expect(releaseStateAuthority(dead.ref, oldAuthority.receipt)).toBe(false);
    expect(readStateAuthority(dead.ref)).toEqual(successor.receipt);

    const stale = loadStateForResume({ ref: dead.ref, authority: oldAuthority });
    expect(stale.kind).toBe('invalid');
    expect(() =>
      transitionAndSave(
        dead.ref,
        createInitialState('stale-owner'),
        { type: 'ENQUEUE_USER_MSG', message: queuedMessage('stale') },
        {
          expectedRevision: oldAuthority.receipt.stateRevision,
          authority: oldAuthority.receipt,
        },
      ),
    ).toThrow(/state-authority-invalid/iu);

    const current = assertValidHead(
      dead.ref,
      successor.receipt.stateRevision,
      successor.receipt.fence,
      successor.receipt.ownerId,
    );
    expect(current.messageQueue).toEqual([]);
  });

  it('promotes v3 resume state once and leaves future observation bytes untouched', () => {
    const migrated = fixture('state-write-fencing-migration');
    const legacy = legacyState();
    saveState(migrated.ref, legacy);
    const statePath = join(sessionDir(migrated.ref.projectDir, migrated.ref.sessionId), STATE_FILE);
    const beforeMigration = readFileSync(statePath);
    const authority = fenced(
      acquireStateAuthority({
        ref: migrated.ref,
        purpose: 'resume',
        ownerId: 'migration-owner',
        runId: 'migration-run',
        acquisitionId: 'migration-acquisition',
      }),
    );
    expect(authority.promotedFromVersion).toBe(3);
    const loaded = loadStateForResume({ ref: migrated.ref, authority });
    expect(loaded).toMatchObject({ kind: 'loaded', migrated: true });
    expect(readFileSync(statePath)).not.toEqual(beforeMigration);
    const migratedState = assertValidHead(
      migrated.ref,
      authority.receipt.stateRevision,
      authority.receipt.fence,
      authority.receipt.ownerId,
    );
    expect(migratedState.stateVersion).toBe(4);
    expect(migratedState.briefRecovery?.status).toBe('storage-blocked');

    const observed = fixture('state-write-fencing-observation');
    const futurePath = join(
      sessionDir(observed.ref.projectDir, observed.ref.sessionId),
      STATE_FILE,
    );
    const futureBytes = Buffer.from(
      JSON.stringify({ ...legacyState('future'), stateVersion: 5 }) + '\n',
    );
    writeFileSync(futurePath, futureBytes, { mode: SECURE_FILE_MODE });
    const observation = acquireStateAuthority({
      ref: observed.ref,
      purpose: 'resume',
      acquisitionId: 'future-observation',
    });
    expect(observation.kind).toBe('read-only');
    if (observation.kind !== 'read-only') {
      throw new Error(`Expected read-only authority, got ${observation.kind}.`);
    }
    const readOnlyAuthority: ResumeLoadAuthority = observation;
    const refusal = loadStateForResume({ ref: observed.ref, authority: readOnlyAuthority });
    expect(refusal).toMatchObject({ kind: 'invalid', code: 'future-version' });
    expect(readFileSync(futurePath)).toEqual(futureBytes);
    expect(readStateAuthority(observed.ref)).toBeNull();
  });
});

type AtomicCutPoint =
  | 'beforeLockPublish'
  | 'open'
  | 'chmod'
  | 'write'
  | 'fsync'
  | 'stat'
  | 'read'
  | 'compare'
  | 'rename'
  | 'close'
  | 'link'
  | 'beforeLockMove';

const ATOMIC_CUT_POINTS: readonly AtomicCutPoint[] = [
  'beforeLockPublish',
  'open',
  'chmod',
  'write',
  'fsync',
  'stat',
  'read',
  'compare',
  'rename',
  'close',
  'beforeLockMove',
];

function failingAtomicOperation(cutPoint: AtomicCutPoint): ConfinedAtomicWriteSyncTestOperations {
  const fail = (): never => {
    throw new Error(`injected atomic cut point: ${cutPoint}`);
  };
  switch (cutPoint) {
    case 'beforeLockPublish':
      return { beforeLockPublish: fail };
    case 'open':
      return { open: fail };
    case 'chmod':
      return { chmod: fail };
    case 'write':
      return { write: fail };
    case 'fsync':
      return { fsync: fail };
    case 'stat':
      return { stat: fail };
    case 'read':
      return { read: fail };
    case 'compare':
      return { compare: fail };
    case 'rename':
      return { rename: fail };
    case 'close':
      return { close: fail };
    case 'link':
      return { link: fail };
    case 'beforeLockMove':
      return { beforeLockMove: fail };
  }
}

describe('atomic state-head cut points', () => {
  it.each(ATOMIC_CUT_POINTS)('does not publish a torn head at %s', (cutPoint) => {
    const directory = createTempDir(`state-write-fencing-${cutPoint}`);
    fixtures.push(directory);
    const target = join(directory, 'state.json');
    const initial = confinedAtomicWriteFileSync(target, Buffer.from('base-head\n'), {
      expectedRevision: null,
      mode: SECURE_FILE_MODE,
    });
    expect(initial.kind).toBe('written');
    if (initial.kind !== 'written') return;

    expect(() =>
      confinedAtomicWriteFileSyncForTest(
        target,
        Buffer.from(`next-head-${cutPoint}\n`),
        { expectedRevision: initial.revision, mode: SECURE_FILE_MODE },
        failingAtomicOperation(cutPoint),
      ),
    ).toThrow();

    const bytes = readFileSync(target, 'utf8');
    if (cutPoint === 'beforeLockMove') {
      expect(bytes).toContain('next-head-beforeLockMove');
    } else {
      expect(bytes).toBe('base-head\n');
    }
  });

  it('does not create a target when the first-writer link cut point fails', () => {
    const directory = createTempDir('state-write-fencing-link');
    fixtures.push(directory);
    const target = join(directory, 'new-state.json');
    expect(() =>
      confinedAtomicWriteFileSyncForTest(
        target,
        Buffer.from('new-head\n'),
        { expectedRevision: null, mode: SECURE_FILE_MODE },
        failingAtomicOperation('link'),
      ),
    ).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
