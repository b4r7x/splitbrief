import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceFinalReviewStatus } from '../../../core/schemas/evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError } from '../../../lib/warn.js';
import { recordFinalReviewEvidence } from '../evidence/reporting.js';

/** A failed ledger write warns and never stops the run: the review outcome is in the state. */
export function recordFinalReviewStatus(ref: SessionRef, status: EvidenceFinalReviewStatus): void {
  try {
    const ledger = readEvidenceLedger(ref);
    if (ledger) writeEvidenceLedger(ref, recordFinalReviewEvidence({ ledger, status }));
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }
}
