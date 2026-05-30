import { describe, expect, it } from 'vitest';
import { recordApprovalEvidence, recordRejectionEvidence } from './approval-evidence.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger.js';
import { makeTask } from '../../../../testing/helpers/factories/task.js';

describe('recordApprovalEvidence / recordRejectionEvidence', () => {
  it('appends approval entry', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordApprovalEvidence({
      ledger,
      tier: 'confirm',
      actionClass: 'destructive',
      actionDescription: 'rm -rf',
      reason: 'needed',
    });
    expect(updated.approvals).toHaveLength(1);
  });

  it('appends rejection entry', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRejectionEvidence({
      ledger,
      tier: 'sticky',
      actionClass: 'write_out_of_scope',
      actionDescription: 'write foo',
      reason: 'denied',
    });
    expect(updated.rejections).toHaveLength(1);
  });
});
