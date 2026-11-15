import type { Phase } from '../../../../core/schemas/enums.js';
import type { Task } from '../../../../core/schemas/task.js';
import { getRunnerDisplayName } from '../../../../core/config/accessors/runner-config.js';
import { resolveReviewCadence } from '../../../../core/config/runtime/resolve.js';
import { replacedFilesSavedIn } from '../../../../core/runtime/commands/messages.js';
import { nowIso } from '../../../../utils/format/time.js';
import {
  gateChangedFiles,
  type GateChangedFilesDecision,
  type GateChangedFilesDenial,
} from '../../approval/gate-files.js';
import { isResumableWorkspaceStop } from '../../isolation/retention.js';
import type { AttemptWorkspace } from '../../isolation/types.js';
import type { WorkflowContext } from '../../types.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { GateDecision } from '../../approval/types.js';
import { publishError } from '../../publish/notice.js';
import { persistApprovalEvidence, persistRejectionEvidence } from '../../evidence/persistence.js';
import { buildApprovalDeniedRecoveryIssue } from '../../recovery/builders/approval.js';
import { parkStoppedRun, raisePendingRecovery } from '../../state-ops/halts.js';
import { resolveDependsOnFiles } from '../resolve-deps.js';

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

/**
 * The change gate of a brief's first attempt. The writes that need approval wait for it, and a
 * denial is recorded. A denial that leaves no write halts the brief, and a cancelled confirmation
 * parks the run as a stop does. Returns the state the brief stops at, or nothing when it goes on.
 */
export async function gateTaskAttempt(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  workspace: AttemptWorkspace;
  preApprovedFiles: string[];
  setTrackedState: (s: WorkflowState) => void;
}): Promise<WorkflowState | undefined> {
  const { wctx, task, state, setTrackedState } = opts;
  const gate = await gateAttemptChanges({
    wctx,
    task,
    phase: state.phase,
    workspace: opts.workspace,
    preApprovedFiles: opts.preApprovedFiles,
    dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
    onApproved: (decision) => persistApprovalEvidence({ wctx, state, decision, taskId: task.id }),
  });
  if (gate.outcome === 'aborted') return state;
  if (gate.outcome === 'cancelled') {
    const parked = await parkStoppedRun(
      { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus },
      state,
      resolveReviewCadence(wctx.config) === 'none',
    );
    setTrackedState(parked);
    return parked;
  }
  if (gate.denial !== undefined) {
    recordApprovalDenial({
      wctx,
      state,
      task,
      denials: gate.denial.decision.denials,
      message: denialMessage({
        subject: 'Task',
        denial: gate.denial,
        blocked: gate.outcome === 'denied',
      }),
      briefKept: gate.denial.briefKept,
    });
  }
  if (gate.outcome === 'denied') {
    const { decision } = gate.denial;
    const issue = buildApprovalDeniedRecoveryIssue({
      task,
      phase: state.phase,
      deniedFiles: decision.deniedFiles,
      ...(decision.reason !== undefined && { denialReason: decision.reason }),
      tool: getRunnerDisplayName(wctx.config.implementer),
      createdAt: nowIso(),
    });
    const halted = raisePendingRecovery(wctx, state, issue);
    setTrackedState(halted);
    return halted;
  }
  return undefined;
}

export function recordApprovalDenial(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  denials: GateDecision[];
  message: string;
  briefKept?: number | undefined;
}): void {
  const { wctx, state, task, denials, message, briefKept } = opts;
  publishError({ bus: wctx.bus, phase: state.phase, message, briefKept });
  for (const decision of denials) {
    const rejectedTier = decision.tier;
    if (
      rejectedTier &&
      rejectedTier !== 'auto' &&
      decision.actionClass &&
      decision.actionDescription
    ) {
      persistRejectionEvidence({
        wctx,
        state,
        reason: decision.reason ?? 'denied',
        actionClass: decision.actionClass,
        tier: rejectedTier,
        actionDescription: decision.actionDescription,
        taskId: task.id,
      });
    }
  }
}
