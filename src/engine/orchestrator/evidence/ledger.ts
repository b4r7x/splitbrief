import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { EVIDENCE_FILE } from '../../../core/paths.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { sessionFileFailure } from '../../../core/sessions/errors.js';
import { sessionRelativePath } from '../../../core/sessions/ownership-marker.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { publishWarning } from '../publish/notice.js';
import type { WorkflowContext } from '../types.js';

/** A lost evidence write warns in plain words and never fails the step that made it. */
export function warnEvidenceNotSaved(
  wctx: Pick<WorkflowContext, 'sessionId' | 'bus'>,
  phase: WorkflowState['phase'],
  err: unknown,
): void {
  publishWarning({
    bus: wctx.bus,
    phase,
    message: sessionFileFailure(
      'Could not save the run evidence',
      sessionRelativePath(wctx.sessionId, EVIDENCE_FILE),
      err,
    ),
  });
}

export function getOrCreateLedger(opts: { ref: SessionRef; state: WorkflowState }): EvidenceLedger {
  const { ref, state } = opts;
  const existing = readEvidenceLedger(ref);
  const briefHash = hashTaskBrief(state.tasks);
  return (
    existing ??
    createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: state.feature,
      tasks: state.tasks,
      briefHash,
    })
  );
}
