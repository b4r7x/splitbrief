import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTaskProjects } from '#testing/helpers/orchestrator-task-context.js';
import { makeRecoveryJournalFixture } from '#testing/helpers/brief-recovery-fixtures.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { readRecoveryJournal } from '../../../core/evidence/recovery-journal/journal.js';
import { loadState } from '../../../core/state/persistence.js';
import type {
  BriefGenerationRef,
  BriefOwnerEvent,
  BriefOwnerExpected,
  BriefOwnerProjectNextInput,
  TaskExecutionPermit,
} from '../../../core/schemas/brief-owner.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { resolveOwnerReadiness } from '../planning/io.js';
import {
  persistBriefOwnerTransition,
  type BriefOwnerTransitionOperations,
} from './brief-owner-journal.js';

afterEach(() => {
  cleanupTaskProjects();
});

describe('persistBriefOwnerTransition — sole fenced owner commit', () => {
  const digest = (seed: string): string => sha256Hex(seed);

  function generationRef(seed: string): BriefGenerationRef {
    return {
      generationId: `generation-${digest(seed).slice(0, 16)}`,
      manifestDigest: digest(`${seed}-manifest`),
      tasksDigest: digest(`${seed}-tasks`),
      qualityDigest: digest(`${seed}-quality`),
      programId: null,
    };
  }

  function permitFor(generation: BriefGenerationRef): TaskExecutionPermit {
    return {
      version: 1,
      epochId: 'epoch-1',
      authorityRevision: 1,
      generationId: generation.generationId,
      manifestDigest: generation.manifestDigest,
      tasksDigest: generation.tasksDigest,
      qualityDigest: generation.qualityDigest,
      approvalEvidence: {
        revision: 1,
        hash: digest('approval'),
        path: 'brief-recovery/epochs/epoch-1/payload/approval.json',
      },
      issuedAt: '2026-08-15T00:00:00.000Z',
    };
  }

  function ownerFixture(): {
    ref: { projectDir: string; sessionId: string };
    expected: BriefOwnerExpected;
  } {
    const fixture = makeRecoveryJournalFixture();
    const ref = { projectDir: fixture.projectDir, sessionId: fixture.sessionId };
    const head = readWorkflowStateHead(ref);
    const recovery = head?.state.briefRecovery;
    if (head === null || recovery === null || recovery === undefined) {
      throw new Error('expected a saved recovery state head');
    }
    return {
      ref,
      expected: {
        epochId: 'epoch-1',
        stateRevision: head.revision,
        authorityRevision: 0,
        fence: String(head.state.stateFence?.token ?? 0),
        evidenceHead: recovery.evidenceHead,
      },
    };
  }

  function generationPublishedEvent(sessionId: string, eventId: string): BriefOwnerEvent {
    return {
      type: 'brief_generation_published',
      ts: 0,
      phase: 'reviewing-briefs',
      version: 1,
      eventId,
      sessionId,
      epochId: 'epoch-1',
      recoveryRevision: 0,
      operationId: `op-${eventId}`,
      generation: generationRef(eventId),
      provenanceDigest: digest(`${eventId}-provenance`),
    };
  }

  function permitIssuedEvent(sessionId: string, eventId: string): BriefOwnerEvent {
    const generation = generationRef(eventId);
    return {
      type: 'brief_execution_permit_issued',
      ts: 0,
      phase: 'reviewing-briefs',
      version: 1,
      eventId,
      sessionId,
      epochId: 'epoch-1',
      recoveryRevision: 0,
      operationId: `op-${eventId}`,
      generation,
      permit: permitFor(generation),
    };
  }

  function parkedProjector() {
    return ({ current }: BriefOwnerProjectNextInput) => ({
      disposition: 'parked' as const,
      authorityRevision: 1,
      generation: null,
      permit: null,
      recovery: { ...current, briefRecovery: current.briefRecovery },
    });
  }

  it('commits a generation publication and delivers the durable event after the CAS', () => {
    const { ref, expected } = ownerFixture();
    const event = generationPublishedEvent(ref.sessionId, 'owner-publish');
    if (event.type !== 'brief_generation_published') {
      throw new Error('expected a generation event');
    }
    const delivered: Array<{ eventId: string; payload: unknown }> = [];

    const result = persistBriefOwnerTransition({
      ref,
      expected,
      operationId: `op-${event.eventId}`,
      evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
      event,
      projectNext: ({ current, evidenceRef, eventId }) => {
        if (current.briefRecovery === null) throw new Error('expected recovery authority');
        return {
          disposition: 'parked',
          authorityRevision: 1,
          generation: event.generation,
          permit: null,
          recovery: {
            ...current,
            briefRecovery: {
              ...current.briefRecovery,
              evidenceHead: evidenceRef.hash,
              outbox: [{ eventId, payloadRef: evidenceRef.path, acknowledged: false }],
            },
          },
        };
      },
      deliver: ({ eventId, payload }) => delivered.push({ eventId, payload }),
    });

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed owner result');
    expect(result.authorityRevision).toBe(1);
    expect(result.generation).toEqual(event.generation);
    expect(result.permit).toBeNull();
    expect(result.recovery?.briefRecovery?.evidenceHead).toBe(readRecoveryJournal(ref).headHash);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.eventId).toBe('owner-publish');
    expect(delivered[0]?.payload).toEqual(event);

    const state = loadState(ref);
    expect(state?.authorityRevision).toBe(1);
    expect(state?.generation).toEqual(event.generation);
    expect(state?.permit).toBeNull();
    expect(state?.briefRecovery?.outbox[0]).toEqual({
      eventId: 'owner-publish',
      payloadRef: expect.any(String),
      acknowledged: true,
    });
    expect(readRecoveryJournal(ref).records).toHaveLength(1);
    expect(readRecoveryJournal(ref).records[0]?.kind).toBe('outcome');
    expect(result.stateRevision.rawSha256).toBe(readWorkflowStateHead(ref)?.revision.rawSha256);
  });

  it('issues the matching permit in the same commit when approval is already complete', () => {
    const { ref, expected } = ownerFixture();
    const event = permitIssuedEvent(ref.sessionId, 'owner-permit');
    if (event.type !== 'brief_execution_permit_issued') {
      throw new Error('expected a permit-issuance event');
    }
    const { bus, events } = makeBusRecorder();

    const result = persistBriefOwnerTransition({
      ref,
      expected,
      operationId: `op-${event.eventId}`,
      evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
      event,
      projectNext: ({ current }) => {
        const briefRecovery = current.briefRecovery;
        if (briefRecovery === null || briefRecovery.status !== 'ready') {
          throw new Error('expected ready recovery authority');
        }
        return {
          disposition: 'ready-for-tasks',
          authorityRevision: 1,
          generation: event.generation,
          permit: event.permit,
          recovery: { ...current, briefRecovery: { ...briefRecovery, status: 'ready' as const } },
        };
      },
      bus,
    });

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('expected committed owner result');
    expect(result.permit).toEqual(event.permit);
    expect(result.recovery?.briefRecovery?.status).toBe('ready');
    const state = loadState(ref);
    expect(state?.permit).toEqual(event.permit);
    expect(state?.briefRecovery?.outbox[0]?.acknowledged).toBe(true);
    expect(events.filter((e) => e.type === 'brief_execution_permit_issued')).toHaveLength(1);
    expect(events.find((e) => e.type === 'brief_execution_permit_issued')).toMatchObject({
      eventId: 'owner-permit',
      generation: event.generation,
      permit: event.permit,
    });
  });

  it('atomically nulls a committed permit when a later patch parks', () => {
    const { ref, expected } = ownerFixture();
    const permitEvent = permitIssuedEvent(ref.sessionId, 'owner-permit-then-park');
    if (permitEvent.type !== 'brief_execution_permit_issued') {
      throw new Error('expected a permit-issuance event');
    }
    const { bus } = makeBusRecorder();

    const issued = persistBriefOwnerTransition({
      ref,
      expected,
      operationId: `op-${permitEvent.eventId}`,
      evidence: { epochId: 'epoch-1', kind: 'outcome', payload: permitEvent },
      event: permitEvent,
      projectNext: ({ current }) => {
        const briefRecovery = current.briefRecovery;
        if (briefRecovery === null || briefRecovery.status !== 'ready') {
          throw new Error('expected ready recovery authority');
        }
        return {
          disposition: 'ready-for-tasks',
          authorityRevision: 1,
          generation: permitEvent.generation,
          permit: permitEvent.permit,
          recovery: { ...current, briefRecovery: { ...briefRecovery, status: 'ready' as const } },
        };
      },
      bus,
    });
    expect(issued.kind).toBe('committed');

    const head = readWorkflowStateHead(ref);
    const recovery = head?.state.briefRecovery;
    if (head === null || recovery === null || recovery === undefined) {
      throw new Error('expected a committed recovery state head');
    }
    const parkEvent: BriefOwnerEvent = {
      type: 'brief_recovery_refused',
      ts: 0,
      phase: 'reviewing-briefs',
      version: 1,
      eventId: 'owner-park-after-permit',
      sessionId: ref.sessionId,
      epochId: 'epoch-1',
      recoveryRevision: 1,
      briefRevision: 1,
      briefHash: digest('brief'),
      reportRevision: null,
      reportHash: null,
      intentId: 'intent-park',
      operationId: 'op-owner-park',
      action: 'reject',
      refusalCategory: 'quality',
      refusalCode: 'brief_compiler_capacity',
      status: 'blocked',
    };

    const parked = persistBriefOwnerTransition({
      ref,
      expected: {
        epochId: 'epoch-1',
        stateRevision: head.revision,
        authorityRevision: 1,
        fence: String(head.state.stateFence?.token ?? 0),
        evidenceHead: recovery.evidenceHead,
      },
      operationId: 'op-owner-park',
      evidence: { epochId: 'epoch-1', kind: 'rejection', payload: parkEvent },
      event: parkEvent,
      projectNext: ({ current }) => ({
        disposition: 'parked',
        authorityRevision: 2,
        generation: permitEvent.generation,
        permit: null,
        recovery: { ...current, briefRecovery: current.briefRecovery },
      }),
      bus,
    });

    expect(parked.kind).toBe('committed');
    if (parked.kind !== 'committed') throw new Error('expected committed park result');
    expect(parked.permit).toBeNull();
    expect(parked.generation).toEqual(permitEvent.generation);
    const state = loadState(ref);
    expect(state?.permit).toBeNull();
    expect(state?.generation).toEqual(permitEvent.generation);
    expect(state?.authorityRevision).toBe(2);
    expect(state?.briefRecovery?.outbox).toHaveLength(2);
    expect(resolveOwnerReadiness(ref)).toEqual({ ok: false, reason: 'no-permit' });
  });

  it('returns conflict for a stale expected tuple and changes no evidence, state, or outbox', () => {
    const { ref, expected } = ownerFixture();
    const event = generationPublishedEvent(ref.sessionId, 'owner-stale');
    const journalHeadBefore = readRecoveryJournal(ref).headHash;
    const stateBefore = loadState(ref);
    const delivered: string[] = [];

    const result = persistBriefOwnerTransition({
      ref,
      expected: {
        ...expected,
        stateRevision: { ...expected.stateRevision, rawSha256: 'f'.repeat(64) },
      },
      operationId: `op-${event.eventId}`,
      evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
      event,
      projectNext: parkedProjector(),
      deliver: ({ eventId }) => delivered.push(eventId),
    });

    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('expected conflict owner result');
    expect(result.stateRevision).toBeNull();
    expect(result.recovery).toBeNull();
    expect(delivered).toEqual([]);
    expect(readRecoveryJournal(ref).headHash).toBe(journalHeadBefore);
    expect(loadState(ref)).toEqual(stateBefore);
  });

  it('rejects an owner patch whose generation differs from the event generation', () => {
    const { ref, expected } = ownerFixture();
    const event = generationPublishedEvent(ref.sessionId, 'owner-mismatched-generation');
    const stateBefore = loadState(ref);
    const journalBefore = readRecoveryJournal(ref);
    const delivered: string[] = [];
    const otherGeneration = generationRef('other');

    expect(() =>
      persistBriefOwnerTransition({
        ref,
        expected,
        operationId: `op-${event.eventId}`,
        evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
        event,
        projectNext: ({ current }) => ({
          disposition: 'parked',
          authorityRevision: 1,
          generation: otherGeneration,
          permit: null,
          recovery: { ...current, briefRecovery: current.briefRecovery },
        }),
        deliver: ({ eventId }) => delivered.push(eventId),
      }),
    ).toThrowError(expect.objectContaining({ kind: 'brief-owner-event-patch-mismatch' }));
    expect(delivered).toEqual([]);
    expect(readRecoveryJournal(ref).headHash).toBe(journalBefore.headHash);
    expect(readRecoveryJournal(ref).records).toHaveLength(journalBefore.records.length);
    expect(loadState(ref)).toEqual(stateBefore);
  });

  it('rejects an owner patch that nulls the generation of a published event', () => {
    const { ref, expected } = ownerFixture();
    const event = generationPublishedEvent(ref.sessionId, 'owner-nulled-generation');
    const stateBefore = loadState(ref);

    expect(() =>
      persistBriefOwnerTransition({
        ref,
        expected,
        operationId: `op-${event.eventId}`,
        evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
        event,
        projectNext: parkedProjector(),
      }),
    ).toThrowError(expect.objectContaining({ kind: 'brief-owner-event-patch-mismatch' }));
    expect(readRecoveryJournal(ref).records).toHaveLength(0);
    expect(loadState(ref)).toEqual(stateBefore);
  });

  it.each([
    {
      label: 'epoch',
      mutate: (expected: BriefOwnerExpected) => ({ ...expected, epochId: 'other-epoch' }),
    },
    { label: 'fence', mutate: (expected: BriefOwnerExpected) => ({ ...expected, fence: '9' }) },
    {
      label: 'evidence head',
      mutate: (expected: BriefOwnerExpected) => ({ ...expected, evidenceHead: 'e'.repeat(64) }),
    },
    {
      label: 'authority revision',
      mutate: (expected: BriefOwnerExpected) => ({ ...expected, authorityRevision: 3 }),
    },
  ])('returns conflict when the expected $label does not match the head', ({ mutate }) => {
    const { ref, expected } = ownerFixture();
    const event = generationPublishedEvent(ref.sessionId, 'owner-mismatch');
    const result = persistBriefOwnerTransition({
      ref,
      expected: mutate(expected),
      operationId: `op-${event.eventId}`,
      evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
      event,
      projectNext: parkedProjector(),
    });
    expect(result.kind).toBe('conflict');
    expect(readRecoveryJournal(ref).records).toHaveLength(0);
  });

  it('reuses one evidence record after a pre-CAS crash and commits on replay', () => {
    const { ref, expected } = ownerFixture();
    const event = generationPublishedEvent(ref.sessionId, 'owner-replay');
    if (event.type !== 'brief_generation_published') {
      throw new Error('expected a generation event');
    }
    const projectNext = ({ current }: BriefOwnerProjectNextInput) => ({
      disposition: 'parked' as const,
      authorityRevision: 1,
      generation: event.generation,
      permit: null,
      recovery: { ...current, briefRecovery: current.briefRecovery },
    });
    const commit = (operations: Partial<BriefOwnerTransitionOperations> = {}) =>
      persistBriefOwnerTransition({
        ref,
        expected,
        operationId: `op-${event.eventId}`,
        evidence: { epochId: 'epoch-1', kind: 'outcome', payload: event },
        event,
        projectNext,
        ...operations,
      });

    expect(() =>
      commit({
        onFault: (point) => {
          if (point === 'before-state-cas') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');
    expect(readRecoveryJournal(ref).records).toHaveLength(1);
    expect(loadState(ref)?.briefRecovery?.outbox).toEqual([]);

    const delivered: string[] = [];
    const retry = commit({ deliver: ({ eventId }) => delivered.push(eventId) });
    expect(retry.kind).toBe('committed');
    expect(readRecoveryJournal(ref).records).toHaveLength(1);
    expect(delivered).toEqual(['owner-replay']);
    expect(loadState(ref)?.briefRecovery?.outbox[0]?.acknowledged).toBe(true);
  });

  it('records refusal evidence under the rejection journal kind', () => {
    const { ref, expected } = ownerFixture();
    const event: BriefOwnerEvent = {
      type: 'brief_recovery_refused',
      ts: 0,
      phase: 'reviewing-briefs',
      version: 1,
      eventId: 'owner-refused',
      sessionId: ref.sessionId,
      epochId: 'epoch-1',
      recoveryRevision: 0,
      briefRevision: 1,
      briefHash: digest('brief'),
      reportRevision: null,
      reportHash: null,
      intentId: 'intent-refused',
      operationId: null,
      action: 'retry',
      refusalCategory: 'quality',
      refusalCode: 'brief_compiler_capacity',
      status: 'blocked',
    };

    const result = persistBriefOwnerTransition({
      ref,
      expected,
      operationId: 'op-owner-refused',
      evidence: { epochId: 'epoch-1', kind: 'rejection', payload: event },
      event,
      projectNext: parkedProjector(),
    });

    expect(result.kind).toBe('committed');
    expect(readRecoveryJournal(ref).records).toHaveLength(1);
    expect(readRecoveryJournal(ref).records[0]?.kind).toBe('rejection');
    expect(readRecoveryJournal(ref).records[0]?.operationId).toBe('op-owner-refused');
  });
});
