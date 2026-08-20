import { describe, expect, it } from 'vitest';
import {
  BriefGenerationRefSchema,
  BriefOwnerCommitResultSchema,
  BriefOwnerExpectedSchema,
  BriefOwnerEventSchema,
  BriefOwnerStatePatchSchema,
  ConfigRevisionSchema,
  TaskExecutionPermitSchema,
} from './brief-owner.js';
import type { BriefOwnerStatePatch } from './brief-owner.js';

const revision = {
  rawSha256: 'revision-hash',
  fileIdentity: { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n },
} as const;

const generation = {
  generationId: 'generation-1',
  manifestDigest: 'manifest-1',
  tasksDigest: 'tasks-1',
  qualityDigest: 'quality-1',
  programId: 'program-1',
} as const;

const evidence = {
  revision: 1,
  hash: 'evidence-hash',
  path: 'brief-recovery/receipt.json',
} as const;

const permit = {
  version: 1,
  epochId: 'epoch-1',
  authorityRevision: 2,
  generationId: generation.generationId,
  manifestDigest: generation.manifestDigest,
  tasksDigest: generation.tasksDigest,
  qualityDigest: generation.qualityDigest,
  approvalEvidence: evidence,
  issuedAt: '2026-08-15T00:00:00.000Z',
} as const;

const recoveryHash = 'a'.repeat(64);
const readyRecoveryView = {
  stateVersion: 4,
  stateRevision: 1,
  stateFence: { token: 1, ownerId: 'owner-1' },
  phase: 'reviewing-briefs',
  briefRecovery: {
    version: 1,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    status: 'ready',
    activeBrief: { revision: 1, hash: recoveryHash, path: 'tasks.md' },
    matchingReport: null,
    qualityPolicyVersion: 'brief-quality-v1',
    automaticRepair: {
      policy: 'existing-one-shot',
      eligible: true,
      consumed: true,
      operationId: 'operation-1',
    },
    attempts: {},
    activeOperationId: null,
    inputs: [],
    nextInputSequence: 1,
    noProgress: { fingerprint: null, count: 0 },
    evidenceHead: recoveryHash,
    outbox: [],
  },
} as const;

describe('BriefGenerationRefSchema and TaskExecutionPermitSchema', () => {
  it('bind generation authority and permit identity', () => {
    expect(BriefGenerationRefSchema.parse(generation)).toEqual(generation);
    expect(TaskExecutionPermitSchema.parse(permit)).toEqual(permit);
    expect(
      TaskExecutionPermitSchema.safeParse({ ...permit, tasksDigest: 'different-tasks' }).success,
    ).toBe(true);
  });

  it('keeps state revisions and expected owner fences structured', () => {
    expect(ConfigRevisionSchema.safeParse(revision).success).toBe(true);
    expect(
      BriefOwnerExpectedSchema.safeParse({
        epochId: 'epoch-1',
        stateRevision: revision,
        authorityRevision: 1,
        fence: 'fence-1',
        evidenceHead: null,
      }).success,
    ).toBe(true);
    expect(
      BriefOwnerExpectedSchema.safeParse({
        epochId: 'epoch-1',
        stateRevision: revision,
        authorityRevision: -1,
        fence: 'fence-1',
        evidenceHead: null,
      }).success,
    ).toBe(false);
  });
});

describe('owner commit contract', () => {
  it('has one result union and a disposition-bearing state patch', () => {
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: { ...readyRecoveryView, briefRecovery: null },
        authorityRevision: 2,
        generation: null,
        permit: null,
        disposition: 'parked',
      }).success,
    ).toBe(true);
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: readyRecoveryView,
        authorityRevision: 2,
        generation,
        permit,
        disposition: 'ready-for-tasks',
      }).success,
    ).toBe(true);
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: {
          ...readyRecoveryView,
          briefRecovery: { ...readyRecoveryView.briefRecovery, status: 'blocked' },
        },
        authorityRevision: 2,
        generation,
        permit,
        disposition: 'ready-for-tasks',
      }).success,
    ).toBe(false);
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: { ...readyRecoveryView, briefRecovery: null },
        authorityRevision: 2,
        generation,
        permit,
        disposition: 'ready-for-tasks',
      }).success,
    ).toBe(false);
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: { ...readyRecoveryView, briefRecovery: null },
        authorityRevision: 2,
        generation: null,
        permit,
        disposition: 'parked',
      }).success,
    ).toBe(false);
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: { ...readyRecoveryView, briefRecovery: null },
        authorityRevision: 2,
        generation: null,
        permit: null,
        disposition: 'terminal',
      }).success,
    ).toBe(true);
    expect(
      BriefOwnerStatePatchSchema.safeParse({
        recovery: { status: 'blocked' },
        authorityRevision: 2,
        generation,
        permit,
        disposition: 'ready-for-tasks',
      }).success,
    ).toBe(false);
    expect(
      BriefOwnerCommitResultSchema.safeParse({
        kind: 'conflict',
        stateRevision: null,
        authorityRevision: null,
        recovery: null,
        generation: null,
        permit: null,
      }).success,
    ).toBe(true);
    expect(
      BriefOwnerCommitResultSchema.safeParse({
        kind: 'committed',
        stateRevision: null,
        authorityRevision: null,
        recovery: null,
        generation: null,
        permit: null,
      }).success,
    ).toBe(false);
    expect(
      BriefOwnerCommitResultSchema.safeParse({
        kind: 'committed',
        stateRevision: revision,
        authorityRevision: 2,
        recovery: readyRecoveryView,
        generation,
        permit,
      }).success,
    ).toBe(true);
  });

  it('narrows patch fields by disposition at compile time', () => {
    const readyPatch: BriefOwnerStatePatch = {
      recovery: readyRecoveryView,
      authorityRevision: 2,
      generation,
      permit,
      disposition: 'ready-for-tasks',
    };
    if (readyPatch.disposition === 'ready-for-tasks') {
      expect(readyPatch.generation.generationId).toBe(generation.generationId);
      expect(readyPatch.permit.generationId).toBe(generation.generationId);
      expect(readyPatch.recovery.briefRecovery.status).toBe('ready');
    }

    // @ts-expect-error ready-for-tasks cannot omit the authoritative generation
    const missingGeneration: BriefOwnerStatePatch = {
      recovery: readyRecoveryView,
      authorityRevision: 2,
      generation: null,
      permit,
      disposition: 'ready-for-tasks',
    };
    // @ts-expect-error parked patches cannot carry an execution permit
    const parkedWithPermit: BriefOwnerStatePatch = {
      recovery: { ...readyRecoveryView, briefRecovery: null },
      authorityRevision: 2,
      generation: null,
      permit,
      disposition: 'parked',
    };
    expect(missingGeneration).toBeDefined();
    expect(parkedWithPermit).toBeDefined();
  });

  it('keeps owner events typed and rejects open payloads', () => {
    const refused = {
      type: 'brief_recovery_refused',
      ts: 1,
      phase: 'reviewing-briefs',
      version: 1,
      eventId: 'event-1',
      sessionId: 'session-1',
      epochId: 'epoch-1',
      recoveryRevision: 1,
      briefRevision: 1,
      briefHash: recoveryHash,
      reportRevision: null,
      reportHash: null,
      intentId: 'intent-1',
      operationId: null,
      action: 'approve',
      refusalCategory: 'quality',
      refusalCode: 'brief_quality_blocked',
      status: 'blocked',
    } as const;
    expect(BriefOwnerEventSchema.safeParse(refused).success).toBe(true);
    expect(
      BriefOwnerEventSchema.safeParse({
        type: 'brief_recovery_refused',
        payload: refused,
      }).success,
    ).toBe(false);
    expect(
      BriefOwnerEventSchema.safeParse({
        ...refused,
        type: 'brief_generation_published',
        payload: { generation },
      }).success,
    ).toBe(false);
  });
});
