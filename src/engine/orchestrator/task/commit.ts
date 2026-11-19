import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { Config } from '../../../core/schemas/config.js';
import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { ValidationAcceptance } from '../validation/types.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle/contract.js';
import type { WorkflowContext } from '../types.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { captureTaskReviewChanges } from '../evidence/review-capture.js';
import { attributedCheckoutFiles, persistTaskEvidence } from '../evidence/persistence.js';
import { keptCheckoutPathsMessage } from '../isolation/checkout-entries.js';
import { publishWarning } from '../publish/notice.js';
import { publishTaskComplete } from '../publish/task.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import { readBriefWorkedMs } from './worked-time.js';
import { lineageRemainder } from './booking.js';
import { recordTaskUsage } from './record-usage.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';

type ValidateCommitOptions = {
  task: Task;
  acceptance: ValidationAcceptance;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  /** Where the brief's first attempt started; null when no attempt ran, so no file is the brief's. */
  taskStartSnapshot: ChangedFilesSnapshot | null;
  config: Config;
  state: WorkflowState;
  bus: EventBus;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS';
  commitSuffix?: string | undefined;
  retryCount?: number | undefined;
  implementerProfile?: string | undefined;
  taskChangedFiles?: string[] | undefined;
  /** What a `file-bundle-v1` response put on disk; absent for every other grammar. */
  applyResult?: BundleApplyResult | undefined;
};

/**
 * SCOPE_RULE's suggested set: this brief's declared set plus the files of every
 * brief already done. What a task wrote outside that set is what the review
 * names as touched, not suggested.
 */
export function touchedNotSuggestedFiles(opts: {
  task: Task;
  tasks: readonly Task[];
  taskChangedFiles: readonly string[];
}): string[] {
  const suggested = [
    ...taskDeclaredPatterns(opts.task),
    ...opts.tasks.filter((t) => isTaskCompleted(t.status)).flatMap((t) => t.suggestedFiles),
  ];
  return opts.taskChangedFiles.filter((file) => !isInDeclaredSet(file, suggested));
}

/**
 * A completion carries the brief's duration: one log read for its event and its ledger entry. It
 * also carries the files the brief books: its own, and the unbooked files of its lineage that it
 * names or, as the lineage's last open brief, all of them.
 */
type CommitResult =
  | { state: WorkflowState; completed: false }
  | { state: WorkflowState; completed: true; durationMs: number; bookedFiles: string[] };

export async function validateCommitAndAdvance(opts: ValidateCommitOptions): Promise<CommitResult> {
  const {
    task,
    acceptance,
    projectDir,
    sessionId,
    bus,
    method,
    transitionType,
    state,
    retryCount,
    implementerProfile,
  } = opts;
  // An application that did not finish is never this brief's completion, and no
  // validation verdict over the files that did land can make it one.
  if (opts.applyResult !== undefined && opts.applyResult.status !== 'applied') {
    return { state, completed: false };
  }
  if (!acceptance.accepted) {
    return { state, completed: false };
  }

  const durationMs = await readBriefWorkedMs({ projectDir, sessionId }, task.id);
  // Read before the transition: the pass that closes the lineage drops its start.
  const lineage = await lineageRemainder({
    ref: { projectDir, sessionId },
    workspaceDir: opts.workspaceDir,
    state,
    task,
  });
  const ownFiles =
    opts.taskStartSnapshot === null
      ? []
      : await getChangedFilesSinceSnapshot(opts.workspaceDir, opts.taskStartSnapshot);
  const since = lineage?.since ?? opts.taskStartSnapshot;
  const observedFiles = [...new Set([...ownFiles, ...(lineage?.files ?? [])])];
  const bookedFiles =
    state.workspace?.kind === 'checkout'
      ? await attributedCheckoutFiles({ projectDir, sessionId }, since ?? undefined, observedFiles)
      : observedFiles;
  const unresolved = observedFiles.filter((path) => !bookedFiles.includes(path));
  if (unresolved.length > 0) {
    publishWarning({ bus, phase: state.phase, message: keptCheckoutPathsMessage(unresolved) });
  }
  const nextState = transitionAndSave({ projectDir, sessionId }, state, {
    type: transitionType,
  });
  publishTaskComplete(
    { bus: bus, phase: nextState.phase },
    {
      taskId: task.id,
      title: task.title,
      method,
      retries: retryCount ?? state.attempt,
      duration: durationMs,
      ...(state.implementerTool !== undefined && { tool: state.implementerTool }),
      ...(state.implementerModel !== undefined && { model: state.implementerModel }),
      ...(implementerProfile !== undefined && { implementerProfile }),
    },
  );
  const touchedNotSuggested = touchedNotSuggestedFiles({
    task,
    tasks: state.tasks,
    taskChangedFiles:
      state.workspace?.kind === 'checkout' ? bookedFiles : (opts.taskChangedFiles ?? []),
  });
  if (touchedNotSuggested.length > 0) {
    bus.publish({
      type: 'task_touched_not_suggested',
      ts: Date.now(),
      phase: nextState.phase,
      taskId: task.id,
      files: touchedNotSuggested,
    });
  }
  if (since !== null) {
    await captureTaskReviewChanges({
      ref: { projectDir, sessionId },
      workspaceDir: opts.workspaceDir,
      task,
      since,
      files: bookedFiles,
    });
  }

  return { state: nextState, completed: true, durationMs, bookedFiles };
}

/**
 * Accepts a brief whose first attempt passed its checks: the commit, then the brief's usage and
 * its evidence. Returns the state of the accepted brief, or nothing when the commit did not
 * complete it.
 */
export async function acceptLocalAttempt(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  acceptance: ValidationAcceptance;
  taskChangedFiles: string[];
  applyResult: BundleApplyResult | undefined;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  onTaskAcceptedFiles?: ((files: string[]) => void) | undefined;
}): Promise<WorkflowState | undefined> {
  const { wctx, task } = opts;
  const { config } = wctx;
  const commitResult = await validateCommitAndAdvance({
    task,
    projectDir: wctx.projectDir,
    workspaceDir: wctx.workspaceDir,
    sessionId: wctx.sessionId,
    taskStartSnapshot: opts.taskStartSnapshot,
    config,
    bus: wctx.bus,
    state: opts.state,
    method: 'local',
    transitionType: 'VALIDATION_PASS',
    acceptance: opts.acceptance,
    implementerProfile: wctx.implementerProfile,
    taskChangedFiles: opts.taskChangedFiles,
    applyResult: opts.applyResult,
  });
  if (!commitResult.completed) return undefined;
  const { state } = commitResult;
  opts.setTrackedState(state);
  opts.onTaskAcceptedFiles?.(commitResult.bookedFiles);
  recordTaskUsage({
    task,
    method: 'local',
    tokensBefore: opts.tokensBefore,
    currentUsage: state.tokenUsage,
    bus: wctx.bus,
    state,
    taskBreakdowns: opts.taskBreakdowns,
    tool: getRunnerDisplayName(config.implementer),
    ...(config.implementer.model !== undefined && { model: config.implementer.model }),
    ...(wctx.implementerProfile !== undefined && {
      implementerProfile: wctx.implementerProfile,
    }),
    ...(wctx.routingDecision !== undefined && { routingDecision: wctx.routingDecision }),
  });
  await persistTaskEvidence({
    wctx,
    state,
    task,
    recordKind: 'local',
    details: {
      status: 'done',
      method: 'local',
      retries: 0,
      durationMs: commitResult.durationMs,
      changedFiles: commitResult.bookedFiles,
    },
  });
  return state;
}
