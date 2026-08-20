import { describe, expect, it } from 'vitest';
import { BriefOwnerEventSchema } from '../../core/schemas/brief-owner.js';
import { parseEngineEvent } from './schema.js';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);

const generation = {
  generationId: 'generation-1',
  manifestDigest: hash,
  tasksDigest: hash,
  qualityDigest: hash,
  programId: 'program-1',
} as const;

const evidence = {
  revision: 1,
  hash,
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

const base = {
  ts: 1,
  phase: 'reviewing-briefs' as const,
  version: 1 as const,
  eventId: 'event-1',
  sessionId: 'session-1',
  epochId: 'epoch-1',
  recoveryRevision: 1,
};

const refs = {
  briefRevision: 1,
  briefHash: hash,
  reportRevision: 1,
  reportHash: hash,
};

const refused = {
  ...base,
  type: 'brief_recovery_refused' as const,
  ...refs,
  intentId: 'intent-1',
  operationId: null,
  action: 'approve' as const,
  refusalCategory: 'quality' as const,
  refusalCode: 'brief_quality_blocked',
  status: 'blocked' as const,
};

const accepted = {
  ...base,
  type: 'brief_recovery_accepted' as const,
  ...refs,
  operationId: 'operation-1',
  intentHash: hash,
  attemptKind: 'automatic' as const,
  status: 'accepted' as const,
  dispatchPossibility: 'none' as const,
  frozenInputCount: 0,
  queuedInputCount: 0,
  automaticAllowanceConsumed: true,
};

const published = {
  ...base,
  type: 'brief_generation_published' as const,
  operationId: 'operation-1',
  generation,
  provenanceDigest: otherHash,
};

const permitIssued = {
  ...base,
  type: 'brief_execution_permit_issued' as const,
  operationId: 'operation-1',
  generation,
  permit,
};

describe('durable owner publication events', () => {
  it('round-trips every owner event variant with its stable identities', () => {
    for (const event of [refused, accepted, published, permitIssued]) {
      const parsed = parseEngineEvent(event);
      expect(parsed).toEqual(expect.objectContaining(event));
      expect(BriefOwnerEventSchema.safeParse(parsed).success).toBe(true);
    }
    const parsedPublished = parseEngineEvent(published);
    if (parsedPublished === null || parsedPublished.type !== 'brief_generation_published') {
      throw new Error('published event did not parse');
    }
    expect(parsedPublished.generation.generationId).toBe('generation-1');
    expect(parsedPublished.generation.programId).toBe('program-1');
    expect(parsedPublished.provenanceDigest).toBe(otherHash);
    const parsedPermit = parseEngineEvent(permitIssued);
    if (parsedPermit === null || parsedPermit.type !== 'brief_execution_permit_issued') {
      throw new Error('permit event did not parse');
    }
    expect(parsedPermit.permit.generationId).toBe('generation-1');
    expect(parsedPermit.permit.epochId).toBe('epoch-1');
  });

  it('keeps attempt acceptance and owner acceptance as distinct event types', () => {
    expect(
      parseEngineEvent({
        ...accepted,
        type: 'brief_recovery_attempt_accepted',
      }),
    ).toEqual(expect.objectContaining({ type: 'brief_recovery_attempt_accepted' }));
    expect(
      parseEngineEvent({
        ...accepted,
        type: 'brief_recovery_attempt_accepted',
        operationId: 'operation-1',
      }),
    ).not.toEqual(expect.objectContaining({ type: 'brief_recovery_accepted' }));
  });

  it('rejects a permit that does not identify the published generation', () => {
    expect(
      parseEngineEvent({
        ...permitIssued,
        permit: { ...permit, generationId: 'generation-other' },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...permitIssued,
        permit: { ...permit, manifestDigest: otherHash },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...permitIssued,
        permit: { ...permit, tasksDigest: otherHash },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...permitIssued,
        permit: { ...permit, qualityDigest: otherHash },
      }),
    ).toBeNull();
  });

  it('rejects a permit bound to a different owner epoch', () => {
    expect(
      parseEngineEvent({
        ...permitIssued,
        permit: { ...permit, epochId: 'epoch-other' },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...permitIssued,
        epochId: 'epoch-other',
        permit: { ...permit, epochId: 'epoch-other' },
      }),
    ).not.toBeNull();
  });

  it('requires the full generation ref and provenance identity on publication', () => {
    const { generation: _omitted, ...withoutGeneration } = published;
    expect(parseEngineEvent(withoutGeneration)).toBeNull();
    expect(parseEngineEvent({ ...published, provenanceDigest: undefined })).toBeNull();
    expect(
      parseEngineEvent({
        ...published,
        generation: { ...generation, programId: undefined },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...published,
        generation: { ...generation, manifestDigest: 'short' },
      }),
    ).not.toBeNull();
  });

  it('requires the permit payload on the permit-issued event', () => {
    const { permit: _omitted, ...withoutPermit } = permitIssued;
    expect(parseEngineEvent(withoutPermit)).toBeNull();
    const { generation: _generationOmitted, ...withoutGeneration } = permitIssued;
    expect(parseEngineEvent(withoutGeneration)).toBeNull();
  });

  it('never treats generation publication alone as readiness', () => {
    const claimedReadiness = {
      ...published,
      disposition: 'ready-for-tasks',
    };
    expect(parseEngineEvent(claimedReadiness)).toBeNull();
    expect(
      parseEngineEvent({
        ...published,
        type: 'brief_execution_permit_issued',
      }),
    ).toBeNull();
  });

  it('rejects secrets and physical lease paths on every owner event variant', () => {
    for (const event of [refused, accepted, published, permitIssued]) {
      for (const key of ['apiKey', 'credentials', 'providerPayload', 'leasePath', 'sockPath']) {
        expect(parseEngineEvent({ ...event, [key]: 'sentinel-secret' })).toBeNull();
      }
    }
  });
});
