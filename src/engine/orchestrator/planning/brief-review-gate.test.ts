import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { BriefReadinessDecision } from '../../../core/schemas/brief-recovery/attempt.js';
import { BriefRecoveryProjectionV1Schema } from '../../../core/schemas/brief-recovery/document.js';
import {
  type BriefRecoveryCommand,
  type RecoveryResultV1,
  RecoveryResultV1Schema,
  type StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { EvidenceRef } from '../../../core/schemas/brief-recovery/primitives.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { BriefReadinessGateReport } from './brief-readiness-gate.js';
import { buildBriefReviewProof, runBriefReviewExit } from './brief-review-gate.js';

const sessionId = 'session-1';
const epochId = 'epoch-1';
const briefBytes = '# Task Briefs\n';
const brief = { revision: 3, hash: sha256Hex(briefBytes), path: 'tasks.md' } satisfies EvidenceRef;
const reportBytes = JSON.stringify({
  version: 1,
  briefHash: brief.hash,
  ruleVersion: 'brief-quality-v1',
  issues: [],
  errorCount: 0,
});
const report = {
  revision: 3,
  hash: sha256Hex(reportBytes),
  path: 'brief-quality.json',
} satisfies EvidenceRef;
function restagedReport(bytes: string) {
  return { reportBytes: bytes, report: { ...report, hash: sha256Hex(bytes) } };
}

const task = makeTask({ id: 'T001', evidence: ['proof'] });
const authority: StateAuthorityReceipt = {
  kind: 'usable',
  sessionId,
  ownerId: 'owner-1',
  pid: 1,
  processStart: 'start-1',
  runId: 'run-1',
  acquisitionId: 'acquisition-1',
  fence: 4,
  stateRevision: 3,
  stateDigest: 'digest-1',
};

function result(
  continuation: RecoveryResultV1['projection']['continuation'],
  status: 'ready' | 'blocked' | 'readiness-blocked' = 'ready',
): RecoveryResultV1 {
  const projection = BriefRecoveryProjectionV1Schema.parse({
    version: 1,
    sessionId,
    stateRevision: 3,
    recoveryRevision: 2,
    epochId,
    status,
    origin:
      continuation?.kind === 'approval'
        ? { mode: continuation.mode, entry: continuation.entry }
        : { mode: 'quick', entry: continuation?.entry ?? 'initial' },
    continuation,
    activeBrief: brief,
    matchingReport: {
      briefHash: brief.hash,
      report,
      ruleVersion: 'brief-quality-v1',
      issues: [],
    },
    blocker: status === 'blocked' ? { kind: 'quality', issues: [] } : null,
    allowedActions: ['status'],
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  });
  return RecoveryResultV1Schema.parse(
    status === 'ready'
      ? { version: 1, sessionId, epochId, projection, kind: 'ready', operationId: null }
      : {
          version: 1,
          sessionId,
          epochId,
          projection,
          kind: 'blocked',
          code:
            status === 'readiness-blocked' ? 'brief_readiness_blocked' : 'brief_contract_blocked',
          operationId: null,
        },
  );
}

function proofInput(kind: 'approval' | 'quick-start' | 'instant-start' = 'approval') {
  const continuation =
    kind === 'approval'
      ? { version: 1 as const, kind, mode: 'standard' as const, entry: 'initial' as const }
      : { version: 1 as const, kind, entry: 'initial' as const };
  return {
    sessionId,
    epochId,
    operationId: 'approve-1',
    brief,
    report,
    briefBytes,
    reportBytes,
    qualityPolicyVersion: 'brief-quality-v1',
    stateRevision: authority.stateRevision,
    fence: authority.fence,
    continuation,
  };
}

const readinessWarning: BriefReadinessGateReport = {
  ok: false,
  metadata: [{ taskId: task.id }],
  blocks: [{ taskId: task.id, kind: 'overflow', message: 'overflow', nextAction: 'split' }],
};

describe('buildBriefReviewProof', () => {
  it.each([
    ['missing brief', { briefBytes: null }, 'missing-brief-bytes'],
    ['missing report', { reportBytes: null }, 'missing-report-bytes'],
    ['mismatched brief', { briefBytes: 'changed' }, 'brief-hash-mismatch'],
    ['mismatched report', { reportBytes: '{}' }, 'report-hash-mismatch'],
    [
      'mismatched rule',
      restagedReport(
        JSON.stringify({
          version: 1,
          briefHash: brief.hash,
          ruleVersion: 'old',
          issues: [],
          errorCount: 0,
        }),
      ),
      'quality-policy-version-mismatch',
    ],
    ['malformed report', restagedReport('{'), 'malformed-report-bytes'],
    [
      'report for another brief',
      restagedReport(
        JSON.stringify({
          version: 1,
          briefHash: sha256Hex('# Other Task Briefs\n'),
          ruleVersion: 'brief-quality-v1',
          issues: [],
          errorCount: 0,
        }),
      ),
      'report-brief-hash-mismatch',
    ],
  ])('%s is fail-closed', (_label, change, code) => {
    const proof = buildBriefReviewProof({ ...proofInput(), ...change });
    expect(proof).toMatchObject({ ok: false, code });
  });

  it('hashes the exact bytes and yields a deterministic intent', () => {
    const first = buildBriefReviewProof(proofInput());
    const second = buildBriefReviewProof(proofInput());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      proof: { briefHash: brief.hash, reportHash: report.hash },
    });
  });
});

describe('runBriefReviewExit', () => {
  it('dispatches approval before readiness and materializes only after a clean contract', async () => {
    const calls: string[] = [];
    const ready = result(proofInput().continuation);
    const controller = {
      dispatchBriefAction: async (command: BriefRecoveryCommand) => {
        calls.push(command.action);
        return ready;
      },
    };
    const materialized: unknown[] = [];
    const outcome = await runBriefReviewExit({
      controller,
      authority,
      admission: ready,
      proof: proofInput(),
      tasks: [task],
      readiness: () => {
        calls.push('readiness');
        return { ok: true, metadata: [], blocks: [] };
      },
      materialize: (input) => {
        calls.push('materialize');
        materialized.push(input);
      },
    });

    expect(outcome.kind).toBe('materialized');
    expect(calls).toEqual(['approve', 'readiness', 'materialize']);
    expect(materialized).toHaveLength(1);
  });

  it('keeps Contract Blocked ahead of readiness', async () => {
    const blocked = result(proofInput().continuation, 'blocked');
    const controller = { dispatchBriefAction: async () => blocked };
    let readinessCalls = 0;
    let materializeCalls = 0;
    const outcome = await runBriefReviewExit({
      controller,
      authority,
      admission: blocked,
      proof: proofInput(),
      tasks: [task],
      readiness: () => {
        readinessCalls += 1;
        return readinessWarning;
      },
      materialize: () => {
        materializeCalls += 1;
      },
    });

    expect(outcome.kind).toBe('contract-blocked');
    expect(readinessCalls).toBe(0);
    expect(materializeCalls).toBe(0);
  });

  it('requires repeat confirmation for readiness warnings after Contract Ready', async () => {
    const ready = result(proofInput().continuation);
    const controller = { dispatchBriefAction: async () => ready };
    let materializeCalls = 0;
    let persisted: BriefReadinessDecision | undefined;
    const first = await runBriefReviewExit({
      controller,
      authority,
      admission: ready,
      proof: proofInput(),
      tasks: [task],
      readiness: () => readinessWarning,
      recordReadinessDecision: (decision) => {
        persisted = decision;
        return result(proofInput().continuation, 'readiness-blocked');
      },
      materialize: () => {
        materializeCalls += 1;
      },
    });
    expect(first.kind).toBe('readiness-blocked');
    expect(persisted).toMatchObject({
      kind: 'blocked',
      briefHash: brief.hash,
      reportHash: report.hash,
      qualityPolicyVersion: 'brief-quality-v1',
    });
    expect(materializeCalls).toBe(0);

    const second = await runBriefReviewExit({
      controller,
      authority,
      admission: ready,
      proof: proofInput(),
      tasks: [task],
      readiness: () => readinessWarning,
      ...(persisted === undefined ? {} : { readinessDecision: persisted }),
      recordReadinessDecision: (decision) => {
        persisted = decision;
        return result(proofInput().continuation);
      },
      materialize: () => {
        materializeCalls += 1;
      },
    });
    expect(second.kind).toBe('materialized');
    expect(persisted?.kind).toBe('override');
    expect(materializeCalls).toBe(1);
  });

  it.each(['quick-start', 'instant-start'] as const)(
    '%s continues without synthetic approval',
    async (kind) => {
      const admitted = result(proofInput(kind).continuation);
      let dispatchCalls = 0;
      const outcome = await runBriefReviewExit({
        controller: {
          dispatchBriefAction: async () => {
            dispatchCalls += 1;
            return admitted;
          },
        },
        authority,
        admission: admitted,
        proof: proofInput(kind),
        tasks: [task],
        readiness: () => readinessWarning,
        materialize: () => {},
      });
      expect(outcome.kind).toBe('materialized');
      expect(dispatchCalls).toBe(0);
    },
  );
});
