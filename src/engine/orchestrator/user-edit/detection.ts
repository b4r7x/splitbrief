import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { UserEditConflictAction } from '../../../core/schemas/enums.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { changedFilesSinceBaseline, type ChangedFilesBaseline } from '../changed-files-baseline.js';
import { classifyUserEditConflict, normalizeUserEditConflictAction } from './conflicts.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { publishUserEditConflict, publishWarning, publishWarningFromError } from '../events.js';
import { nowIso } from '../../../utils/format-time.js';
import { raisePendingRecovery } from '../state-ops.js';
import { buildUserEditConflictRecoveryIssue } from '../recovery/builders/workflow.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { readConfinedEntry } from '../approval/file-snapshots/entry.js';
import { recordedTargetOutput } from '../evidence/task.js';
import type { EvidencePromotedFile } from '../../../core/schemas/evidence.js';
import { closeRunIfOpen } from '../run/close.js';

/** Whether `file` still holds bytes the brief is on record as having written there. */
async function holdsRecordedWrite(input: {
  projectDir: string;
  file: string;
  writes: EvidencePromotedFile[];
}): Promise<boolean> {
  const { projectDir, file, writes } = input;
  const write = writes.find((write) => write.path === file);
  if (write === undefined) return false;
  try {
    const entry = await readConfinedEntry(projectDir, file);
    return entry.kind === 'absent'
      ? write.sha256 === null && write.mode === null
      : write.sha256 === entry.sha256 && write.mode === (entry.mode & 0o777);
  } catch {
    return false;
  }
}

/** The pre-task gate and resume lookup must agree on current target ownership. */
export async function assessChangedUserEdits(opts: {
  projectDir: string;
  sessionId: string;
  task: Task;
  changedFiles: string[];
}): Promise<{
  ownFiles: string[];
  foreignFiles: string[];
  currentTaskInFlight: boolean;
}> {
  const { projectDir, sessionId, task, changedFiles } = opts;
  const output = recordedTargetOutput({ projectDir, sessionId }, task);
  const declared =
    task.status === 'in_progress'
      ? changedFiles.filter((file) => isInDeclaredSet(file, taskDeclaredPatterns(task)))
      : [];
  const ownFiles: string[] = [];
  for (const file of declared) {
    if (await holdsRecordedWrite({ projectDir, file, writes: output.files })) ownFiles.push(file);
  }
  const foreignFiles = changedFiles.filter((file) => !ownFiles.includes(file));
  return {
    ownFiles,
    foreignFiles,
    currentTaskInFlight: task.status === 'in_progress' && output.hasOutput,
  };
}

export async function checkUserEditConflicts(opts: {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  task: Task;
  taskIndex: number;
  baseline: ChangedFilesBaseline;
  acknowledgedUserEditFiles: Set<string>;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{
  state: WorkflowState;
  stopped: boolean;
  cancelled: boolean;
  absorbedFiles: string[];
}> {
  const {
    projectDir,
    sessionId,
    callbacks,
    bus,
    task,
    taskIndex,
    baseline,
    acknowledgedUserEditFiles,
    setTrackedState,
  } = opts;
  const { state } = opts;
  const scope = { projectDir, sessionId, bus };

  let changedFiles: string[];
  try {
    changedFiles = await changedFilesSinceBaseline(projectDir, baseline);
  } catch (err) {
    publishWarningFromError(
      { bus, phase: state.phase },
      'Failed to check user edit conflicts',
      err,
    );
    return { state, stopped: false, cancelled: false, absorbedFiles: [] };
  }
  if (changedFiles.length === 0)
    return { state, stopped: false, cancelled: false, absorbedFiles: [] };

  const { ownFiles, foreignFiles, currentTaskInFlight } = await assessChangedUserEdits({
    projectDir,
    sessionId,
    task,
    changedFiles,
  });
  if (ownFiles.length > 0) {
    for (const file of ownFiles) acknowledgedUserEditFiles.add(file);
    publishWarning({
      bus,
      phase: state.phase,
      taskId: task.id,
      message: `Keeping ${task.id}'s own unfinished output: ${ownFiles.join(', ')}.`,
      safety: { category: 'user-edit', code: 'own_partial_output_kept' },
    });
  }
  if (foreignFiles.length === 0)
    return { state, stopped: false, cancelled: false, absorbedFiles: [] };

  const conflict = classifyUserEditConflict({
    files: foreignFiles,
    currentTask: task,
    currentTaskInFlight,
    allTasks: state.tasks,
    currentTaskIndex: taskIndex,
  });

  if (conflict.kind === 'unrelated') {
    const absorbedFiles = conflict.fileConflicts.map((fileConflict) => fileConflict.file);
    for (const file of absorbedFiles) acknowledgedUserEditFiles.add(file);
    publishUserEditConflict({ bus: bus, phase: state.phase }, conflict, 'continue-unrelated');
    return { state, stopped: false, cancelled: false, absorbedFiles };
  }

  let selectedAction: UserEditConflictAction;
  if (conflict.safeToContinue) {
    if (callbacks.onUserEditConflict) {
      try {
        selectedAction = normalizeUserEditConflictAction(
          conflict,
          await callbacks.onUserEditConflict(conflict),
          'continue-unrelated',
        );
      } catch {
        selectedAction = 'pause';
      }
    } else {
      selectedAction = normalizeUserEditConflictAction(
        conflict,
        'continue-unrelated',
        'continue-unrelated',
      );
    }
  } else {
    selectedAction = 'pause';
  }
  publishUserEditConflict({ bus: bus, phase: state.phase }, conflict, selectedAction);

  if (selectedAction === 'abort-workflow') {
    const closure = closeRunIfOpen({ projectDir, sessionId }, state);
    setTrackedState(closure.state);
    return {
      state: closure.state,
      stopped: true,
      cancelled: closure.closedNow,
      absorbedFiles: [],
    };
  }

  if (selectedAction === 'continue-unrelated' && conflict.safeToContinue) {
    const absorbedFiles = conflict.fileConflicts
      .filter(
        (fileConflict) =>
          fileConflict.kind === 'unrelated' || fileConflict.kind === 'future-task-stale-input',
      )
      .map((fileConflict) => fileConflict.file);
    for (const file of absorbedFiles) acknowledgedUserEditFiles.add(file);
    return { state, stopped: false, cancelled: false, absorbedFiles };
  }

  const issue = buildUserEditConflictRecoveryIssue({
    conflict,
    currentTask: task,
    phase: state.phase,
    createdAt: nowIso(),
  });
  return {
    state: raisePendingRecovery(scope, state, issue, setTrackedState),
    stopped: true,
    cancelled: false,
    absorbedFiles: [],
  };
}

export async function detectValidationFailureUserEdit(opts: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  task: Task;
  taskIndex: number;
  taskChangedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; diverted: boolean }> {
  const { projectDir, sessionId, bus, task, taskIndex, taskChangedFiles, setTrackedState } = opts;
  const { state } = opts;

  let failingUniverse: string[];
  try {
    failingUniverse = await getChangedFilesSinceSnapshot(projectDir, opts.taskStartSnapshot);
  } catch (err) {
    publishWarningFromError(
      { bus, phase: state.phase },
      'Failed to inspect validation-failure changed files',
      err,
    );
    return { state, diverted: false };
  }

  const attributed = new Set(taskChangedFiles);
  const foreignFiles = failingUniverse.filter((file) => !attributed.has(file));
  if (foreignFiles.length === 0) return { state, diverted: false };

  // This path runs only after the brief's own validation failed, so the brief is in flight by
  // construction — whatever the status on the task copy threaded down from the loop says.
  const conflict = classifyUserEditConflict({
    files: foreignFiles,
    currentTask: task,
    currentTaskInFlight: true,
    allTasks: state.tasks,
    currentTaskIndex: taskIndex,
  });
  if (conflict.kind === 'unrelated' || conflict.kind === 'future-task-stale-input') {
    return { state, diverted: false };
  }

  publishUserEditConflict({ bus, phase: state.phase }, conflict, 'pause');
  const issue = buildUserEditConflictRecoveryIssue({
    conflict,
    currentTask: task,
    phase: state.phase,
    createdAt: nowIso(),
  });
  const next = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue, setTrackedState);
  return { state: next, diverted: true };
}
