import { describe, expect, it } from 'vitest';
import {
  BriefRecoveryProjectionV1Schema,
  BriefRecoveryStatusSchema,
  RecoveryResultV1Schema,
} from './brief-recovery.js';
import {
  BRIEF_REVIEW_COMMAND_ACTIONS,
  BriefReviewActionIdSchema,
  BriefReviewCommandSchema,
  BriefReviewProjectionSchema,
  BriefReviewResultSchema,
  BriefReviewStatusSchema,
  allowedBriefReviewCommandsForPrompt,
  isBriefReviewCommandCurrent,
} from './brief-review-command.js';

const identity = {
  version: 1 as const,
  sessionId: 'session-1',
  epochId: 'epoch-1',
  operationId: 'operation-1',
  expectedBriefRevision: 2,
  expectedReportRevision: 3,
  intentHash: 'intent-1',
  base: { revision: 2, hash: 'brief-hash', path: 'tasks.md' },
  baseReport: { revision: 3, hash: 'report-hash', path: 'brief-quality.json' },
};

const commands = [
  {
    ...identity,
    action: 'retry' as const,
    diagnosticFingerprint: 'diagnostic-1',
    frozenInputIds: [],
  },
  { ...identity, action: 'edit' as const, briefText: '# Updated Brief', newInputId: 'input-1' },
  { ...identity, action: 'reject' as const, userIntentId: 'reject-1' },
  { ...identity, action: 'approve' as const },
  { ...identity, action: 'comment' as const, comment: 'Please clarify task ownership.' },
  { ...identity, action: 'import' as const },
  {
    ...identity,
    action: 'resolve-unresolved' as const,
    heldInputIds: ['held-1'],
    resolution: { kind: 'rebind' as const, acknowledgeRemoteDuplicationRisk: true as const },
  },
];

const projection = {
  version: 1 as const,
  sessionId: 'session-1',
  stateRevision: 8,
  recoveryRevision: 4,
  epochId: 'epoch-1',
  status: 'blocked' as const,
  origin: { mode: 'standard' as const, entry: 'initial' as const },
  continuation: {
    version: 1 as const,
    kind: 'approval' as const,
    mode: 'standard' as const,
    entry: 'initial' as const,
  },
  activeBrief: { revision: 2, hash: 'brief-hash', path: 'tasks.md' },
  matchingReport: {
    briefHash: 'brief-hash',
    report: { revision: 3, hash: 'report-hash', path: 'brief-quality.json' },
    ruleVersion: 'brief-quality-v1',
    issues: [],
  },
  blocker: null,
  allowedActions: ['retry', 'edit', 'reject'] as const,
  activeOperation: null,
  latestAttempt: null,
  queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
};

describe('Brief Review command contract', () => {
  it('round-trips every explicit recovery command discriminant', () => {
    for (const command of commands) {
      expect(BriefReviewCommandSchema.parse(command)).toEqual(command);
    }
  });

  it('reuses the canonical status and projection schemas', () => {
    expect(BriefReviewProjectionSchema).toBe(BriefRecoveryProjectionV1Schema);
    expect(BriefReviewResultSchema).toBe(RecoveryResultV1Schema);
    expect(BriefReviewStatusSchema).toBe(BriefRecoveryStatusSchema);
    expect(BriefReviewStatusSchema.parse('unresolved')).toBe('unresolved');
    expect(BriefReviewActionIdSchema.parse('resolve-unresolved')).toBe('resolve-unresolved');
  });

  it('keeps command actions discoverable only for Brief prompts', () => {
    expect(allowedBriefReviewCommandsForPrompt('briefs')).toEqual(BRIEF_REVIEW_COMMAND_ACTIONS);
    expect(allowedBriefReviewCommandsForPrompt('artifact')).toEqual([]);
  });

  it('rejects duplicate IDs and preserves equal duplicate command bytes', () => {
    const first = BriefReviewCommandSchema.parse(commands[0]);
    const second = BriefReviewCommandSchema.parse({ ...commands[0] });
    expect(second).toEqual(first);
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[0],
        frozenInputIds: ['input-1', 'input-1'],
      }).success,
    ).toBe(false);
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[6],
        heldInputIds: ['held-1', 'held-1'],
      }).success,
    ).toBe(false);
  });

  it('rejects missing, stale, and future identities', () => {
    expect(BriefReviewCommandSchema.safeParse({ ...commands[0], sessionId: '' }).success).toBe(
      false,
    );
    for (const field of [
      'sessionId',
      'epochId',
      'operationId',
      'intentHash',
      'base',
      'expectedBriefRevision',
      'expectedReportRevision',
    ]) {
      const missing: Record<string, unknown> = { ...commands[0] };
      delete missing[field];
      expect(BriefReviewCommandSchema.safeParse(missing).success, field).toBe(false);
    }
    expect(
      BriefReviewCommandSchema.safeParse({ ...commands[0], expectedBriefRevision: -1 }).success,
    ).toBe(false);
    expect(BriefReviewCommandSchema.safeParse({ ...commands[0], version: 2 }).success).toBe(false);
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[0],
        expectedBriefRevision: 3,
      }).success,
    ).toBe(false);
    const parsed = BriefReviewCommandSchema.parse(commands[0]);
    if (parsed.action !== 'retry') {
      throw new Error('the first fixture must be a retry command');
    }
    expect(isBriefReviewCommandCurrent(parsed, projection)).toBe(true);
    expect(isBriefReviewCommandCurrent({ ...parsed, expectedReportRevision: 4 }, projection)).toBe(
      false,
    );
    expect(isBriefReviewCommandCurrent({ ...parsed, epochId: 'epoch-old' }, projection)).toBe(
      false,
    );
    expect(
      isBriefReviewCommandCurrent(
        { ...parsed, base: { ...parsed.base, hash: 'stale-brief' } },
        projection,
      ),
    ).toBe(false);
  });

  it('bounds edits/comments and keeps retry comment-free', () => {
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[1],
        briefText: 'x'.repeat(1_048_577),
      }).success,
    ).toBe(false);
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[4],
        comment: 'x'.repeat(4_097),
      }).success,
    ).toBe(false);
    expect(
      BriefReviewCommandSchema.safeParse({ ...commands[0], comment: 'retry again' }).success,
    ).toBe(false);
  });

  it('requires every held input and an explicit rebind acknowledgement or abandon', () => {
    expect(BriefReviewCommandSchema.safeParse({ ...commands[6], heldInputIds: [] }).success).toBe(
      false,
    );
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[6],
        resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: false },
      }).success,
    ).toBe(false);
    expect(
      BriefReviewCommandSchema.safeParse({
        ...commands[6],
        resolution: { kind: 'abandon' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown actions', () => {
    expect(
      BriefReviewCommandSchema.safeParse({ ...commands[0], action: 'retry-now' }).success,
    ).toBe(false);
  });
});
