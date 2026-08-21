import { describe, expect, it } from 'vitest';
import {
  BriefRecoveryProjectionV1Schema,
  type BriefRecoveryProjectionV1,
} from '../../core/schemas/brief-recovery.js';
import type { BriefQualityReport } from '../../engine/spec/brief-quality.js';
import type { BriefReadinessGateReport } from '../../engine/orchestrator/planning/brief-readiness-gate.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import {
  formatBriefRecoveryCause,
  formatBriefRecoveryStatus,
  formatEvidenceSpine,
  formatEvidenceSpineLines,
  formatQualityDisplay,
  formatTaskCount,
} from './brief-review-format.js';

function makeProjection(
  overrides: Partial<BriefRecoveryProjectionV1> = {},
): BriefRecoveryProjectionV1 {
  return BriefRecoveryProjectionV1Schema.parse({
    version: 1,
    sessionId: 'session-1',
    stateRevision: 4,
    recoveryRevision: 3,
    epochId: 'epoch-1',
    status: 'blocked',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: { revision: 3, hash: 'brief-hash', path: 'brief.md' },
    matchingReport: {
      briefHash: 'brief-hash',
      report: { revision: 4, hash: 'report-hash', path: 'quality.json' },
      ruleVersion: 'quality-v1',
      issues: [],
    },
    blocker: null,
    allowedActions: ['retry', 'edit', 'reject'],
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: {
      ids: ['input-1', 'input-2', 'input-3', 'input-4'],
      count: 4,
      carriedCount: 1,
      heldCount: 1,
      releasedCount: 1,
    },
    ...overrides,
  });
}

const readinessBlocked: BriefReadinessGateReport = {
  ok: false,
  metadata: [],
  blocks: [],
};

describe('formatQualityDisplay', () => {
  it('returns quality score formatted to 2 decimal places when report is present', () => {
    const report: BriefQualityReport = {
      version: 1,
      passed: true,
      score: 0.91,
      issues: [],
    };
    expect(formatQualityDisplay(report)).toBe('quality 0.91');
  });

  it('returns "quality n/a" when quality report is null', () => {
    expect(formatQualityDisplay(null)).toBe('quality n/a');
  });

  it('returns quality 1.00 for perfect score', () => {
    const report: BriefQualityReport = {
      version: 1,
      passed: true,
      score: 1,
      issues: [],
    };
    expect(formatQualityDisplay(report)).toBe('quality 1.00');
  });

  it('returns quality 0.00 for zero score', () => {
    const report: BriefQualityReport = {
      version: 1,
      passed: false,
      score: 0,
      issues: [],
    };
    expect(formatQualityDisplay(report)).toBe('quality 0.00');
  });
});

describe('formatTaskCount', () => {
  it('returns singular "task" for count of 1', () => {
    expect(formatTaskCount(1)).toBe('1 task');
  });

  it('returns plural "tasks" for count other than 1', () => {
    expect(formatTaskCount(0)).toBe('0 tasks');
    expect(formatTaskCount(4)).toBe('4 tasks');
  });
});

describe('Evidence Spine formatter', () => {
  it.each([
    ['checking', 'CHECKING CONTRACT'],
    ['auto-repairing', 'AUTO-REPAIRING'],
    ['blocked', 'CONTRACT BLOCKED'],
    ['storage-blocked', 'CONTRACT BLOCKED'],
    ['retrying', 'RETRYING'],
    ['unresolved', 'RETRY UNRESOLVED'],
    ['ready', 'CONTRACT READY'],
    ['readiness-blocked', 'READINESS BLOCKED'],
    ['rejected', 'CONTRACT BLOCKED'],
  ] as const)('uses the exact %s status grammar', (status, expected) => {
    const projection =
      status === 'storage-blocked'
        ? makeProjection({ status, activeBrief: null, matchingReport: null })
        : makeProjection({ status });
    expect(formatBriefRecoveryStatus(projection)).toBe(expected);
  });

  it('keeps outcome, cause, and action ahead of secondary score and counts', () => {
    const projection = makeProjection({
      matchingReport: {
        briefHash: 'brief-hash',
        report: { revision: 4, hash: 'report-hash', path: 'quality.json' },
        ruleVersion: 'quality-v1',
        issues: [
          {
            code: 'Q001',
            severity: 'error',
            taskId: null,
            message: 'General contract issue',
          },
        ],
      },
      blocker: {
        kind: 'quality',
        issues: [
          {
            code: 'Q001',
            severity: 'error',
            taskId: null,
            message: 'General contract issue',
          },
        ],
      },
    });
    const quality: BriefQualityReport = {
      version: 1,
      passed: false,
      score: 0.25,
      issues: [],
    };
    const lines = formatEvidenceSpineLines({ projection, quality, taskCount: 0 });

    expect(lines).toEqual([
      'CONTRACT BLOCKED',
      'BRIEF r3 | CHECK r4',
      'BECAUSE QUALITY ISSUE GENERAL: General contract issue',
      'SO approval and implementation are unavailable until errors are cleared',
      'NOW retry, edit, or reject',
      'QUEUED 1 | CARRIED 1 | HELD 1 | ISSUES 1 | WARNINGS 0 | 0 tasks | quality 0.25',
    ]);
  });

  it('distinguishes storage, provider, budget, and unresolved retry causes', () => {
    const cases = [
      {
        projection: makeProjection({
          status: 'storage-blocked',
          activeBrief: null,
          matchingReport: null,
          blocker: { kind: 'storage', code: 'brief_storage_invalid', message: 'cannot read Brief' },
        }),
        expected: 'BECAUSE STORAGE',
      },
      {
        projection: makeProjection({
          blocker: { kind: 'provider', code: 'auth_failed', message: 'token rejected' },
        }),
        expected: 'BECAUSE PROVIDER REFUSAL auth_failed: token rejected',
      },
      {
        projection: makeProjection({
          blocker: { kind: 'budget', code: 'brief_budget_exhausted' },
        }),
        expected: 'BECAUSE BUDGET REFUSAL brief_budget_exhausted',
      },
      {
        projection: makeProjection({
          status: 'unresolved',
          blocker: { kind: 'unresolved', code: 'brief_unresolved', operationId: 'operation-1' },
        }),
        expected: 'BECAUSE UNRESOLVED RETRY operation-1',
      },
    ] as const;

    for (const { projection, expected } of cases) {
      expect(formatBriefRecoveryCause(projection)).toBe(expected);
    }
  });

  it('renders readiness blocking as an explicit cause, consequence, and action', () => {
    const lines = formatEvidenceSpine({
      projection: makeProjection({ status: 'ready' }),
      readiness: readinessBlocked,
    });

    expect(lines.status).toBe('READINESS BLOCKED');
    expect(lines.cause).toBe('BECAUSE READINESS CHECKS');
    expect(lines.consequence).toBe('SO approval is blocked by readiness checks');
    expect(lines.action).toBe('NOW edit or reject');
  });

  it('sanitizes ANSI content and truncates every rail by terminal cells', () => {
    const projection = makeProjection({
      matchingReport: {
        briefHash: 'brief-hash',
        report: { revision: 4, hash: 'report-hash', path: 'quality.json' },
        ruleVersion: 'quality-v1',
        issues: [
          {
            code: 'Q001',
            severity: 'error',
            taskId: null,
            message: '\u001b[31m界面e\u0301\u001b[0m has an issue',
          },
        ],
      },
    });
    const lines = formatEvidenceSpineLines({ projection }, 24);

    for (const line of lines) {
      expect(line).not.toContain('\u001b');
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(24);
    }
  });
});
