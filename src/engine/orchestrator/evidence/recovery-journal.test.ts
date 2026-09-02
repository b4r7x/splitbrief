import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTaskProjects } from '#testing/helpers/orchestrator-task-context.js';
import {
  RECOVERY_FIXTURE_BRIEF_HASH,
  RECOVERY_FIXTURE_REPORT_HASH,
  makeRecoveryJournalFixture,
} from '#testing/helpers/brief-recovery-fixtures.js';
import { readRecoveryEpochManifest } from '../../../core/evidence/recovery-journal/epoch.js';
import { readRecoveryJournal } from '../../../core/evidence/recovery-journal/journal.js';
import { loadState } from '../../../core/state/persistence.js';
import {
  commitRecoveryState,
  closePersistedRecoveryEpoch,
  drainRecoveryOutbox,
  persistRecoveryTransition,
  replayClosedRecoveryEvidence,
  writeLateRecoveryEvidence,
} from './recovery-journal.js';
import { existsSync } from 'node:fs';

afterEach(() => {
  cleanupTaskProjects();
});

describe('persistRecoveryTransition — evidence, state, and outbox ordering', () => {
  it('does not create evidence or state when the crash occurs before evidence', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    expect(() =>
      persistRecoveryTransition({
        ref,
        state: fixture.state,
        nextState: fixture.state,
        epochId: 'epoch-1',
        kind: 'initial-result',
        eventId: 'event-before-evidence',
        payload: { outcome: 'ready' },
        onFault: (point) => {
          if (point === 'before-evidence') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');
    expect(
      existsSync(
        `${fixture.projectDir}/.splitbrief/sessions/${fixture.sessionId}/brief-recovery.jsonl`,
      ),
    ).toBe(false);
    expect(loadState(ref)?.briefRecovery?.outbox).toEqual([]);
  });

  it('reuses the one evidence record after a crash between evidence and state CAS', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    expect(() =>
      persistRecoveryTransition({
        ref,
        state: fixture.state,
        nextState: fixture.state,
        epochId: 'epoch-1',
        kind: 'receipt',
        eventId: 'event-between-cas',
        operationId: 'operation-1',
        payload: { status: 'accepted' },
        onFault: (point) => {
          if (point === 'before-state-cas') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');
    expect(readRecoveryJournal(ref).records).toHaveLength(1);
    expect(loadState(ref)?.briefRecovery?.outbox).toEqual([]);

    const delivered: string[] = [];
    const retry = persistRecoveryTransition({
      ref,
      state: fixture.state,
      nextState: fixture.state,
      epochId: 'epoch-1',
      kind: 'receipt',
      eventId: 'event-between-cas',
      operationId: 'operation-1',
      payload: { status: 'accepted' },
      deliver: ({ eventId }) => delivered.push(eventId),
    });
    expect(retry.kind).toBe('committed');
    expect(retry.acknowledged).toBe(true);
    expect(delivered).toEqual(['event-between-cas']);
    expect(readRecoveryJournal(ref).records).toHaveLength(1);
    expect(loadState(ref)?.briefRecovery?.outbox[0]?.acknowledged).toBe(true);
  });

  it('binds one evidence record when a CAS conflict is retried from the authoritative state', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    const checkpointA = {
      stateRevision: 1,
      recoveryRevision: 1,
      status: 'retrying',
      activeOperationId: 'operation-conflict',
      evidenceHead: RECOVERY_FIXTURE_BRIEF_HASH,
    };
    const checkpointB = {
      stateRevision: 2,
      recoveryRevision: 2,
      status: 'ready',
      activeOperationId: null,
      evidenceHead: RECOVERY_FIXTURE_REPORT_HASH,
    };
    const conflict = persistRecoveryTransition({
      ref,
      state: fixture.state,
      nextState: fixture.state,
      epochId: 'epoch-1',
      kind: 'receipt',
      eventId: 'event-cas-conflict',
      operationId: 'operation-conflict',
      payload: { status: 'accepted' },
      after: checkpointA,
      commitState: ({ ref: commitRef, expected }) => {
        const concurrent = commitRecoveryState({
          ref: commitRef,
          expected,
          next: { ...expected, feature: 'concurrent-change' },
        });
        if (concurrent.kind !== 'committed') {
          throw new Error('expected concurrent state commit');
        }
        return { kind: 'conflict', observedRevision: concurrent.revision };
      },
    });
    expect(conflict.kind).toBe('conflict');
    expect(
      readRecoveryJournal(ref).records.filter((record) => record.eventId === 'event-cas-conflict'),
    ).toHaveLength(0);

    const current = loadState(ref);
    if (current === null) throw new Error('expected authoritative state after conflict');
    const retry = persistRecoveryTransition({
      ref,
      state: current,
      nextState: current,
      epochId: 'epoch-1',
      kind: 'receipt',
      eventId: 'event-cas-conflict',
      operationId: 'operation-conflict',
      payload: { status: 'accepted' },
      after: checkpointB,
    });

    expect(retry.kind).toBe('committed');
    const records = readRecoveryJournal(ref).records.filter(
      (record) => record.eventId === 'event-cas-conflict',
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.after).toEqual(checkpointB);
    expect(loadState(ref)?.briefRecovery?.evidenceHead).toBe(records[0]?.recordHash);
    expect(loadState(ref)?.briefRecovery?.outbox[0]?.eventId).toBe('event-cas-conflict');

    const committedState = loadState(ref);
    if (committedState === null) throw new Error('expected committed recovery state');
    expect(() =>
      persistRecoveryTransition({
        ref,
        state: committedState,
        nextState: committedState,
        epochId: 'epoch-1',
        kind: 'receipt',
        eventId: 'event-cas-conflict',
        operationId: 'operation-conflict',
        payload: { status: 'accepted' },
        after: checkpointA,
      }),
    ).toThrow('recovery event ID is already bound to different evidence');
  });

  it('leaves a committed outbox item for restart drain after state commit', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    expect(() =>
      persistRecoveryTransition({
        ref,
        state: fixture.state,
        nextState: fixture.state,
        epochId: 'epoch-1',
        kind: 'outcome',
        eventId: 'event-after-commit',
        payload: { outcome: 'ready' },
        onFault: (point) => {
          if (point === 'after-state-commit') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');
    expect(loadState(ref)?.briefRecovery?.outbox[0]?.acknowledged).toBe(false);

    const delivered: string[] = [];
    const drained = drainRecoveryOutbox({
      ref,
      deliver: ({ eventId }) => delivered.push(eventId),
    });
    expect(drained.deliveredEventIds).toEqual(['event-after-commit']);
    expect(drained.remainingEventIds).toEqual([]);
    expect(delivered).toEqual(['event-after-commit']);
  });

  it('retries delivery after a pre-ack crash and does not redeliver after an ack crash', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    const delivered: string[] = [];
    expect(() =>
      persistRecoveryTransition({
        ref,
        state: fixture.state,
        nextState: fixture.state,
        epochId: 'epoch-1',
        kind: 'usage-reconciliation',
        eventId: 'event-before-ack',
        payload: { usage: 3 },
        deliver: ({ eventId }) => delivered.push(eventId),
        onFault: (point) => {
          if (point === 'before-acknowledgement') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');
    expect(loadState(ref)?.briefRecovery?.outbox[0]?.acknowledged).toBe(false);
    drainRecoveryOutbox({ ref, deliver: ({ eventId }) => delivered.push(eventId) });
    expect(loadState(ref)?.briefRecovery?.outbox[0]?.acknowledged).toBe(true);

    const stateAfterFirst = loadState(ref);
    if (stateAfterFirst === null) throw new Error('expected committed recovery state');
    expect(() =>
      persistRecoveryTransition({
        ref,
        state: stateAfterFirst,
        nextState: stateAfterFirst,
        epochId: 'epoch-1',
        kind: 'no-progress',
        eventId: 'event-after-ack',
        payload: { count: 20 },
        deliver: ({ eventId }) => delivered.push(eventId),
        onFault: (point) => {
          if (point === 'after-acknowledgement') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');
    const beforeRetryCount = delivered.length;
    drainRecoveryOutbox({ ref, deliver: ({ eventId }) => delivered.push(eventId) });
    expect(delivered.slice(0, 2)).toEqual(['event-before-ack', 'event-before-ack']);
    expect(delivered.length).toBe(beforeRetryCount);
  });

  it('drains duplicate requests idempotently and reconstructs one authoritative head', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    persistRecoveryTransition({
      ref,
      state: fixture.state,
      nextState: fixture.state,
      epochId: 'epoch-1',
      kind: 'reservation',
      eventId: 'event-duplicate-drain',
      payload: { reservation: 'held' },
    });
    const delivered: string[] = [];
    const first = drainRecoveryOutbox({
      ref,
      deliver: ({ eventId }) => delivered.push(eventId),
    });
    const second = drainRecoveryOutbox({
      ref,
      deliver: ({ eventId }) => delivered.push(eventId),
    });
    expect(first.acknowledgedEventIds).toEqual(['event-duplicate-drain']);
    expect(second.deliveredEventIds).toEqual([]);
    expect(delivered).toEqual(['event-duplicate-drain']);
    const state = loadState(ref);
    const journal = readRecoveryJournal(ref);
    expect(state?.briefRecovery?.evidenceHead).toBe(journal.records.at(-1)?.recordHash);
    expect(
      journal.records.filter((record) => record.eventId === 'event-duplicate-drain'),
    ).toHaveLength(1);
  });
});

describe('closed recovery evidence', () => {
  it('writes immutable epoch manifests and deterministic late/replay sidecars', () => {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    const committed = persistRecoveryTransition({
      ref,
      state: fixture.state,
      nextState: fixture.state,
      epochId: 'epoch-1',
      kind: 'receipt',
      eventId: 'event-closed-receipt',
      operationId: 'operation-closed',
      payload: { status: 'settled', outcome: 'provider-failed' },
    });
    if (committed.state === null) throw new Error('expected committed state');
    const manifest = closePersistedRecoveryEpoch({
      ref,
      state: loadState(ref) ?? committed.state,
      epochId: 'epoch-1',
      disposition: 'rejected',
      closedAt: '2026-08-13T00:00:00.000Z',
    });
    expect(readRecoveryEpochManifest(ref, 'epoch-1')).toEqual(manifest);
    const late = writeLateRecoveryEvidence({
      ref,
      epochId: 'epoch-1',
      operationId: 'operation-closed',
      kind: 'late-result',
      payload: { result: 'late' },
    });
    const lateAgain = writeLateRecoveryEvidence({
      ref,
      epochId: 'epoch-1',
      operationId: 'operation-closed',
      kind: 'late-result',
      payload: { result: 'late' },
    });
    expect(late.record.recordHash).toBe(lateAgain.record.recordHash);
    const lateConflictPayload = writeLateRecoveryEvidence({
      ref,
      epochId: 'epoch-1',
      operationId: 'operation-closed',
      kind: 'late-result',
      payload: { result: 'different-late-result' },
    });
    expect(lateConflictPayload.record.recordHash).not.toBe(late.record.recordHash);

    const replay = replayClosedRecoveryEvidence({
      ref,
      epochId: 'epoch-1',
      operationId: 'operation-closed',
      intentHash: RECOVERY_FIXTURE_BRIEF_HASH,
    });
    const replayAgain = replayClosedRecoveryEvidence({
      ref,
      epochId: 'epoch-1',
      operationId: 'operation-closed',
      intentHash: RECOVERY_FIXTURE_BRIEF_HASH,
    });
    expect(replay.sidecar.record.recordHash).toBe(replayAgain.sidecar.record.recordHash);
    expect(
      readRecoveryJournal(ref).records.filter((record) => record.kind === 'replay'),
    ).toHaveLength(1);
    expect(manifest.disposition).toBe('rejected');
  });
});
