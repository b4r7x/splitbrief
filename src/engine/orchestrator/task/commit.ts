import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { captureTaskReviewChanges } from '../evidence/review-capture.js';
import { publishTaskComplete } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import { readBriefWorkedMs } from './worked-time.js';
import { lineageRemainder } from './booking.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';

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
  const bookedFiles = [...new Set([...ownFiles, ...(lineage?.files ?? [])])];
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
    taskChangedFiles: opts.taskChangedFiles ?? [],
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
  const since = lineage?.since ?? opts.taskStartSnapshot;
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
