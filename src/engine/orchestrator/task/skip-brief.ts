import type { Task } from '../../../core/schemas/task.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import { readEvents } from '../../../core/sessions/log/reader.js';
import { hasDispatchedBrief } from '../../../core/state/lineage.js';
import { engineEventFromLogEntry } from '../../events/replay.js';
import type { WorkflowContext } from '../types.js';
import { publishWarning } from '../publish/notice.js';
import { publishTaskSkipped } from '../publish/task.js';
import { type StateStep, transitionsAndSave } from '../state-ops/transition.js';
import { persistSkippedBriefFiles } from '../evidence/persistence.js';
import { captureTaskReviewChanges } from '../evidence/review-capture.js';
import { releaseRetainedWorkspace } from '../isolation/retention.js';
import { lineageRemainder } from './booking.js';
import { type BriefExecutionRoute, recordSettledBrief } from './record-settlement.js';
import {
  restoreExhaustedTaskFiles,
  restoreHookDeniedTaskFiles,
  restoreReplacedAttemptFiles,
} from './rollback.js';

type SkipBriefOptions = {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  reason: string;
  taskStartSnapshot: ChangedFilesSnapshot | undefined;
  expectedRevision?: number | undefined;
};

/**
 * A skipped brief leaves no files behind: every file it changed since its task-start snapshot goes
 * back, and so do the attempts that a rewrite or a split of its lineage replaced. The ledger books
 * on it only the files still changed, or the lineage's unbooked files when it closes the lineage
 * (`recordSkip`). Without a snapshot no attempt of the brief ran, so there is nothing of its own to
 * take back.
 */
export async function skipBrief(
  opts: SkipBriefOptions & { skippedBy: 'pre_task' | 'pre_validation' },
): Promise<WorkflowState> {
  const { wctx, state, taskStartSnapshot, skippedBy } = opts;
  const own =
    taskStartSnapshot === undefined
      ? undefined
      : await restoreHookDeniedTaskFiles({ wctx, taskStartSnapshot, hook: skippedBy });
  const warning = await withReplacedAttempts(opts, own);
  if (warning !== undefined)
    publishWarning({ bus: wctx.bus, phase: state.phase, message: warning });
  return recordSkip(opts);
}

/**
 * The recovery Skip takes the brief's files back like any skip. It returns the restore warning
 * for the caller to publish after the recovery outcome, so the choice and its outcome stay one row.
 * A stopped attempt that the put-back cleared is not kept any more; one whose files the put-back
 * left stays kept, so the next brief puts them back.
 */
export async function skipHaltedBrief(
  opts: SkipBriefOptions,
): Promise<{ state: WorkflowState; restoreWarning: string | undefined }> {
  const { wctx, taskStartSnapshot } = opts;
  const route = await readDispatchedRoute(opts);
  const own =
    taskStartSnapshot === undefined
      ? undefined
      : await restoreExhaustedTaskFiles({ wctx, taskStartSnapshot });
  const restoreWarning = await withReplacedAttempts(opts, own?.message);
  if (own === undefined || own.briefKept === 0) await releaseRetainedWorkspace(wctx);
  return { state: await recordSkip(opts, route), restoreWarning };
}

async function readDispatchedRoute({
  wctx,
  state,
  task,
}: SkipBriefOptions): Promise<BriefExecutionRoute | undefined> {
  if (!hasDispatchedBrief(state, task)) return undefined;
  let route: BriefExecutionRoute | undefined;
  for await (const entry of readEvents(wctx)) {
    if (entry.type !== 'task_started' || entry.taskId !== task.id) continue;
    const started = engineEventFromLogEntry(entry);
    if (started?.type !== 'task_started') continue;
    route = {
      tool: started.tool,
      kind: started.backendKind,
      model: started.model,
      implementerProfile: started.implementerProfile,
      contextFit: started.contextFit,
      currentCodeTruncated: started.currentCodeTruncated,
      currentCodeContextMode: started.currentCodeContextMode,
      routingReason: started.routingReason,
    };
  }
  return route;
}

/**
 * A skip that closes a lineage also takes back the attempts that a rewrite or a split replaced,
 * after the brief's own files, so a file both changed ends where the replaced attempts started,
 * unless a brief done since then booked it. One warning names both restores.
 */
async function withReplacedAttempts(
  opts: SkipBriefOptions,
  own: string | undefined,
): Promise<string | undefined> {
  const replaced = await restoreReplacedAttemptFiles({
    wctx: opts.wctx,
    state: opts.state,
    task: opts.task,
  });
  const warnings = [own, replaced].filter((warning) => warning !== undefined);
  return warnings.length === 0 ? undefined : warnings.join('. ');
}

/**
 * Only the skip that closes the lineage books the lineage's unbooked files, after its take-back.
 * A skip that leaves a brief of the lineage open books none of them: the skip that closes it later
 * takes back the files that no completed brief booked.
 */
async function recordSkip(
  opts: SkipBriefOptions,
  route?: BriefExecutionRoute,
): Promise<WorkflowState> {
  const { wctx, task, reason, taskStartSnapshot } = opts;
  // Read before the transition: the skip that closes the lineage drops its start.
  const remainder = await lineageRemainder({
    ref: wctx,
    workspaceDir: wctx.workspaceDir,
    state: opts.state,
    task,
  });
  const lineage = remainder?.closes === true ? remainder : undefined;
  await persistSkippedBriefFiles({
    wctx,
    state: opts.state,
    task,
    reason,
    taskStartSnapshot,
    lineageFiles: lineage?.files,
  });
  if (lineage !== undefined && lineage.files.length > 0) {
    await captureTaskReviewChanges({
      ref: wctx,
      workspaceDir: wctx.workspaceDir,
      task,
      since: lineage.since,
      files: lineage.files,
    });
  }
  function save(execution?: BriefExecution): WorkflowState {
    const steps: StateStep[] = [{ type: 'SKIP_TASK', taskId: task.id }];
    if (execution !== undefined) {
      steps.push((head) => ({
        ...head,
        taskBreakdowns: [...(head.taskBreakdowns ?? []), execution],
      }));
    }
    return transitionsAndSave(wctx, opts.state, steps, { expectedRevision: opts.expectedRevision });
  }
  const state =
    route === undefined
      ? save()
      : recordSettledBrief({
          bus: wctx.bus,
          task,
          method: 'skipped',
          retryCount: opts.state.attempt,
          route,
          save,
        });
  publishTaskSkipped(
    { bus: wctx.bus, phase: state.phase },
    { taskId: task.id, title: task.title, reason },
  );
  return state;
}
