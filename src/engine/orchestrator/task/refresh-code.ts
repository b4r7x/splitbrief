import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { checkIgnoredPaths } from '../../../lib/git/files.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { assertPathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { matches } from '../../../utils/error.js';
import { anchorAction } from '../../spec/plan-tasks.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { transitionAndSave } from '../state-ops.js';
import type { ContinuationHolder } from '../continuation.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import { entryStoreDir } from '../isolation/entry-snapshot.js';

const isPathEscape = matches('path-confined-escape');

async function readConfined(projectDir: string, file: string): Promise<string | undefined> {
  assertPathConfined(file, projectDir);
  try {
    if (!confinedExists(projectDir, file)) return undefined;
    return (await confinedReadFileAsync(projectDir, file)) ?? undefined;
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) return undefined;
    throw err;
  }
}

/**
 * Context files share this many characters per task: the file that crosses it is cut with a
 * marker, and the files after it are left out (the brief's Scope still names them). A context file
 * the brief also writes is its writable code, never its read-only context.
 */
export const CONTEXT_CODE_BUDGET_CHARS = 40_000;
const TRUNCATED_MARKER = '\n…truncated';

async function readContextCode(task: Task, projectDir: string): Promise<Record<string, string>> {
  const writable = new Set(task.suggestedFiles);
  const codeByFile: Record<string, string> = {};
  let remaining = CONTEXT_CODE_BUDGET_CHARS;
  for (const file of task.contextFiles ?? []) {
    if (remaining === 0) break;
    if (writable.has(file)) continue;
    const content = await readConfined(projectDir, file);
    if (content === undefined) continue;
    codeByFile[file] =
      content.length > remaining ? content.slice(0, remaining) + TRUNCATED_MARKER : content;
    remaining = Math.max(0, remaining - content.length);
  }
  return codeByFile;
}

/**
 * The action a brief takes on its anchor: `create` when the anchor was absent when the brief's
 * lineage started (`LineageRecord.startSnapshot`), so a file the lineage wrote stays `create` for a
 * rewrite, for every split child and at each dispatch. An anchor the workspace does not hold is
 * `create`. Before the lineage's first dispatch no start is recorded, and the workspace decides; it
 * also decides for a git-ignored anchor, which no snapshot records.
 */
export async function lineageAnchorAction(
  ref: SessionRef,
  state: WorkflowState,
  lineageId: TaskId,
  anchor: string,
  workspaceDir: string,
): Promise<Task['action']> {
  const action = anchorAction(anchor, workspaceDir);
  const start = state.lineages?.[lineageId]?.startSnapshot;
  if (action === 'create' || start === undefined) return action;
  const before = await entryToRestore(workspaceDir, start, anchor, entryStoreDir(ref));
  if (before.kind !== 'absent') return 'modify';
  const ignored = await checkIgnoredPaths(start.ignoreProjectDir ?? workspaceDir, [anchor]);
  return ignored.length > 0 ? 'modify' : 'create';
}

/**
 * The brief as it is dispatched: the code of its files as the given directory holds them now, and
 * the action its anchor takes now, since an earlier brief may have created the anchor since the plan.
 */
export async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  const currentCode = await readConfined(projectDir, task.suggestedFiles[0]);

  const codeByFile: Record<string, string> = {};
  for (const file of task.suggestedFiles) {
    if (file === task.suggestedFiles[0]) continue;
    const content = await readConfined(projectDir, file);
    if (content !== undefined) codeByFile[file] = content;
  }
  const contextCodeByFile = await readContextCode(task, projectDir);

  const {
    currentCode: _staleCode,
    currentCodeByFile: _staleCodeByFile,
    contextCodeByFile: _staleContextCode,
    ...base
  } = task;
  return {
    ...base,
    action: anchorAction(task.suggestedFiles[0], projectDir),
    ...(currentCode !== undefined ? { currentCode } : {}),
    ...(Object.keys(codeByFile).length > 0 ? { currentCodeByFile: codeByFile } : {}),
    ...(Object.keys(contextCodeByFile).length > 0 ? { contextCodeByFile } : {}),
  };
}

function hasCode(task: Task): boolean {
  return (
    task.currentCode !== undefined ||
    task.currentCodeByFile !== undefined ||
    task.contextCodeByFile !== undefined
  );
}

/**
 * Whether the brief runs on its own files: it resumes its cut attempt, it replays carrying a
 * failure, or its current revision already dispatched an attempt and runs again on Try again. The
 * changes in its files are then the brief's own output, not a change under it.
 */
export function runsOnOwnFiles(
  state: WorkflowState,
  task: Task,
  continuation: ContinuationHolder | undefined,
): boolean {
  const lineage = state.lineages?.[lineageIdOf(task)];
  return (
    continuation?.resumesAttempt(
      { kind: 'brief', taskId: task.id, attempt: state.attempt },
      hashTaskBrief([task]),
    ) === true ||
    lineage?.carriedFailure !== undefined ||
    lineage?.dispatchedRevision[task.id] === (task.revision ?? 1)
  );
}

/**
 * A brief that resumes its cut attempt keeps the code it was dispatched with: the workspace now
 * also holds that attempt's own output, which is not the brief's input. A retry, and a brief that
 * runs on its own files (`runsOnOwnFiles`: a Continue past a consult bound, a Try again of a
 * dispatched revision), keep the action the brief was dispatched with: an anchor its own earlier
 * attempt wrote is still the file it creates. Any other dispatch takes `lineageAnchorAction`.
 */
export async function refreshAndPersistCode(
  task: Task,
  ref: SessionRef & { continuation?: ContinuationHolder | undefined },
  state: WorkflowState,
  workspaceDir: string,
  entry: 'dispatch' | 'retry',
): Promise<{ task: Task; state: WorkflowState }> {
  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  if (ref.continuation?.resumesAttempt(step, hashTaskBrief([task])) === true) {
    return { task, state };
  }
  const current = await refreshCurrentCode(task, workspaceDir);
  const onOwnFiles = entry === 'retry' || runsOnOwnFiles(state, task, ref.continuation);
  const refreshed = {
    ...current,
    action: onOwnFiles
      ? task.action
      : await lineageAnchorAction(
          ref,
          state,
          lineageIdOf(task),
          task.suggestedFiles[0],
          workspaceDir,
        ),
  };
  if (hasCode(refreshed) || hasCode(task) || refreshed.action !== task.action) {
    state = transitionAndSave(ref, state, {
      type: 'UPDATE_TASK_CODE',
      taskId: refreshed.id,
      action: refreshed.action,
      ...(refreshed.currentCode !== undefined && { code: refreshed.currentCode }),
      ...(refreshed.currentCodeByFile !== undefined && { codeByFile: refreshed.currentCodeByFile }),
      ...(refreshed.contextCodeByFile !== undefined && {
        contextCodeByFile: refreshed.contextCodeByFile,
      }),
    });
  }
  return { task: refreshed, state };
}
