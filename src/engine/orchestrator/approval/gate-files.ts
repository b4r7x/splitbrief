import { uniqueSorted } from '../../../utils/collections.js';
import { gateAction } from './tiered-approval.js';
import type { GateDecision, GateActionInput } from './types.js';

export type GateChangedFilesInput = Omit<GateActionInput, 'actionDescription' | 'targetPath'> & {
  changedFiles: string[];
  /** A stopped run asks about no further file. */
  signal?: AbortSignal | undefined;
};

export type GateChangedFilesDecision = GateDecision & { changedFiles: string[] } & (
    | { allow: true }
    /** A cancelled confirmation stops the gate: no later file is asked about, and none is denied. */
    | { allow: false; cancelled: true }
    | {
        allow: false;
        cancelled?: undefined;
        /** Every path the gate denied; the first denial's details are the decision's own. */
        deniedFiles: string[];
        /** One decision per denied path, in `deniedFiles` order; each is recorded as its own rejection. */
        denials: GateDecision[];
      }
  );

export type GateChangedFilesDenial = Extract<GateChangedFilesDecision, { deniedFiles: string[] }>;

/** Each file is gated on its own: a denial removes that file, never the files around it. */
export async function gateChangedFiles(
  input: GateChangedFilesInput,
): Promise<GateChangedFilesDecision> {
  const changedFiles = uniqueSorted(input.changedFiles);
  const confirmApprovals: NonNullable<GateDecision['confirmApprovals']> = [];
  const deniedFiles: string[] = [];
  const denials: GateDecision[] = [];
  let firstDenial: GateDecision | undefined;
  for (const file of changedFiles) {
    if (input.signal?.aborted) break;
    const actionDescription = `write ${file}`;
    const decision = await gateAction({ ...input, actionDescription, targetPath: file });
    if (decision.cancelled) return { ...decision, allow: false, cancelled: true, changedFiles };
    if (!decision.allow) {
      deniedFiles.push(file);
      denials.push(decision);
      firstDenial ??= { ...decision, actionDescription };
      continue;
    }
    if (decision.confirmApprovals) confirmApprovals.push(...decision.confirmApprovals);
  }

  const firstConfirm = confirmApprovals[0];
  const confirmed = firstConfirm ? { confirmReason: firstConfirm.reason, confirmApprovals } : {};
  if (firstDenial !== undefined) {
    return { ...firstDenial, allow: false, ...confirmed, changedFiles, deniedFiles, denials };
  }
  return { allow: true, changedFiles, ...confirmed };
}
