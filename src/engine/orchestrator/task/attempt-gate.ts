import type { Phase } from '../../../core/schemas/enums.js';
import type { Task } from '../../../core/schemas/task.js';
import { replacedFilesSavedIn } from '../../../core/runtime/commands/messages.js';
import {
  gateChangedFiles,
  type GateChangedFilesDecision,
  type GateChangedFilesDenial,
} from '../approval/gate-files.js';
import { isResumableWorkspaceStop } from '../isolation/retention.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import type { WorkflowContext } from '../types.js';

export type GateDenial = {
  decision: GateChangedFilesDenial;
  /** The writes the denial actually removed; a file changed during the prompt is kept. */
  discardedFiles: string[];
  /** The folder, relative to the project, that holds the bytes the denial replaced in the checkout. */
  savedTo?: string | undefined;
  /** The files a put-back of the brief still acts on after the denial. */
  briefKept?: number | undefined;
};

export type GateAttemptOutcome =
  | { outcome: 'allow'; approvedFiles: string[]; denial?: GateDenial }
  | { outcome: 'denied'; denial: GateDenial }
  | { outcome: 'aborted' }
  | { outcome: 'cancelled' };

/**
 * The row a denial shows. A blocked attempt went nowhere; otherwise only the denied files were
 * dropped and the rest went ahead. Either way it names what was actually discarded, and in the
 * checkout the folder that holds the bytes it replaced.
 */
export function denialMessage(input: {
  subject: string;
  denial: GateDenial;
  blocked: boolean;
}): string {
  const { decision, discardedFiles, savedTo } = input.denial;
  const reason = decision.reason ?? 'denied';
  const lead = input.blocked
    ? `${input.subject} changed files blocked by approval gate: ${reason}.`
    : `Approval gate denied ${decision.deniedFiles.join(', ')}: ${reason}.`;
  const discarded =
    discardedFiles.length === 0
      ? "SPLITBRIEF discarded none of this attempt's writes."
      : `SPLITBRIEF discarded this attempt's writes to ${discardedFiles.join(', ')}.`;
  const saved = savedTo === undefined ? '' : ` ${replacedFilesSavedIn(savedTo)}.`;
  return `${lead} ${discarded}${saved}`;
}

export async function gateAttemptChanges(opts: {
  wctx: WorkflowContext;
  task: Task;
  phase: Phase;
  workspace: AttemptWorkspace;
  preApprovedFiles: string[];
  dependsOnFiles: string[];
  onApproved: (decision: GateChangedFilesDecision) => void;
}): Promise<GateAttemptOutcome> {
  const { wctx, task, phase, workspace, dependsOnFiles, onApproved } = opts;
  const changedFiles = await workspace.changedFiles();
  const preApproved = new Set(opts.preApprovedFiles);
  const filesNeedingApproval = changedFiles.filter((file) => !preApproved.has(file));
  let decision: GateChangedFilesDecision = { allow: true, changedFiles };
  if (filesNeedingApproval.length > 0) {
    decision = await gateChangedFiles({
      changedFiles: filesNeedingApproval,
      task,
      dependsOnFiles,
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      phase,
      taskId: task.id,
      bus: wctx.bus,
      callbacks: wctx.callbacks,
      config: wctx.config,
      signal: wctx.signal,
    });
  }
  if (wctx.signal?.aborted) {
    if (isResumableWorkspaceStop(wctx.signal)) await workspace.retain?.();
    else workspace.cleanup();
    return { outcome: 'aborted' };
  }
  // A cancelled confirmation is the user's stop, so the attempt's writes are kept as a stop keeps them.
  if (decision.cancelled) {
    await workspace.retain?.();
    return { outcome: 'cancelled' };
  }
  let approvedFiles = changedFiles;
  let denial: GateDenial | undefined;
  if (!decision.allow) {
    const { savedTo, briefKept } = await workspace
      .discard(decision.deniedFiles)
      .catch((err: unknown) => {
        workspace.cleanup();
        throw err;
      });
    denial = { decision, discardedFiles: decision.deniedFiles, savedTo, briefKept };
    approvedFiles = changedFiles.filter((file) => !decision.deniedFiles.includes(file));
    if (approvedFiles.length === 0) return { outcome: 'denied', denial };
  }
  if (filesNeedingApproval.length > 0) onApproved(decision);
  return { outcome: 'allow', approvedFiles, ...(denial === undefined ? {} : { denial }) };
}
