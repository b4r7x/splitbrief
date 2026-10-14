import type { Summary } from '../../../core/schemas/summary.js';
import type { EvidenceLedger, EvidenceFinalReviewStatus } from '../../../core/schemas/evidence.js';
import { EVIDENCE_FILE, REVIEW_FILE } from '../../../core/paths.js';
import { nowIso } from '../../../utils/format-time.js';

export type RecordFinalReviewEvidenceInput = {
  ledger: EvidenceLedger;
  status: EvidenceFinalReviewStatus;
  path?: string | undefined;
};

export function recordFinalReviewEvidence(input: RecordFinalReviewEvidenceInput): EvidenceLedger {
  return {
    ...input.ledger,
    finalReview: { path: input.path ?? REVIEW_FILE, status: input.status },
    generatedAt: nowIso(),
  };
}

export function buildRejectionContext(ledger: EvidenceLedger): string {
  const rejections = ledger.rejections ?? [];
  if (rejections.length === 0) return '';
  const lines = rejections.map(
    (r) => `- [${r.tier}] ${r.actionClass}: ${r.actionDescription} (reason: ${r.reason})`,
  );
  return `Previous rejections:\n${lines.join('\n')}\n`;
}

export function buildEvidenceSummary(
  ledger: EvidenceLedger,
): NonNullable<Summary['evidenceSummary']> {
  const totalTasks = ledger.tasks.length;
  const escalatedTasks = ledger.tasks.filter((t) => t.status === 'escalated' || t.escalated).length;
  const failedTasks = ledger.tasks.filter((t) => t.status === 'failed').length;
  const rejectionCount = ledger.rejections?.length ?? 0;
  return {
    path: EVIDENCE_FILE,
    totalTasks,
    escalatedTasks,
    failedTasks,
    rejectionCount,
  };
}
