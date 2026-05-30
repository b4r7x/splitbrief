import { uniqueSorted } from '../../../utils/collections.js';
import { gateAction } from './tiered-approval.js';
import type { GateDecision, GateActionInput } from './tiered-approval.js';

export type GateChangedFilesInput = Omit<GateActionInput, 'actionDescription'> & {
  changedFiles: string[];
};

export type GateChangedFilesDecision = GateDecision & {
  changedFiles: string[];
  rejectedFile?: string;
};

export async function gateChangedFiles(
  input: GateChangedFilesInput,
): Promise<GateChangedFilesDecision> {
  const changedFiles = uniqueSorted(input.changedFiles);
  const confirmApprovals: NonNullable<GateDecision['confirmApprovals']> = [];
  for (const file of changedFiles) {
    const actionDescription = `write ${file}`;
    const decision = await gateAction({
      ...input,
      actionDescription,
    });
    if (!decision.allow) {
      return {
        ...decision,
        changedFiles,
        rejectedFile: file,
        actionDescription,
      };
    }
    if (decision.confirmApprovals) confirmApprovals.push(...decision.confirmApprovals);
  }

  const firstConfirm = confirmApprovals[0];
  return {
    allow: true,
    changedFiles,
    ...(firstConfirm
      ? {
          confirmReason: firstConfirm.reason,
          confirmApprovals,
        }
      : {}),
  };
}
