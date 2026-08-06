import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { AutoSplitOverflowSkippedSplit } from '../auto-split-overflow.js';
import { runBriefQualityGate } from '../planning/brief-quality-gate.js';
import { runBriefReadinessGateAndReport } from '../planning/brief-readiness-gate.js';
import {
  MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS,
  briefReviewFingerprint,
  createBriefReviewTracker,
  publishReadinessBlockWarning,
  readinessBlockDetail,
  recordReadinessOverride,
} from '../planning/brief-review-gate.js';
import { firstBriefErrorMessage } from '../../spec/brief-quality.js';
import { createBusTextHandler, publishError, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import { regenerateTasks } from '../planning/regen.js';

type ApprovedSplitTasksResult = { ok: true; tasks: Task[] } | { ok: false; message: string };

async function readApprovedSplitTasks(
  tasksFilePath: string,
  onWarning?: (message: string) => void,
): Promise<ApprovedSplitTasksResult> {
  try {
    const text = await readFile(tasksFilePath, 'utf8');
    const tasks = parseTasksStrict(text, onWarning);
    return tasks.length > 0
      ? { ok: true, tasks }
      : { ok: false, message: `${tasksFilePath} has no Task Briefs.` };
  } catch (err) {
    return {
      ok: false,
      message: `${tasksFilePath} contains invalid Task Briefs: ${toErrorMessage(err)}`,
    };
  }
}

export async function reviewAutoSplitOutput(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  tasks: Task[];
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; tasks: Task[]; approved: boolean }> {
  const tasksFilePath = join(sessionDir(opts.wctx.projectDir, opts.wctx.sessionId), TASKS_FILE);
  writeSpecFile(
    { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
    TASKS_FILE,
    formatTasks(opts.tasks),
    opts.wctx.metadata,
  );
  publishWarning({
    bus: opts.wctx.bus,
    phase: opts.state.phase,
    message: `Auto-split overflow produced ${opts.tasks.length} Task Briefs. Review ${TASKS_FILE} before implementation.`,
  });

  let state = transitionAndSave(opts.wctx, opts.state, {
    type: 'BRIEFS_READY',
    tasks: opts.tasks,
  });
  opts.setTrackedState(state);

  let tasks = opts.tasks;

  const tracker = createBriefReviewTracker();

  const briefsBody = (): string =>
    readSpecFile(
      { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      TASKS_FILE,
    ) ?? '';

  const rejectNoProgress = (): { state: WorkflowState; tasks: Task[]; approved: false } => {
    publishError({
      bus: opts.wctx.bus,
      phase: state.phase,
      message: `Task Brief review made no progress after ${MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS} consecutive attempts; rejecting the Task Briefs.`,
      safety: { category: 'workflow', code: 'brief_review_no_progress', transcriptSafe: true },
    });
    const rejectedState = transitionAndSave(opts.wctx, state, { type: 'REJECT_BRIEFS' });
    opts.setTrackedState(rejectedState);
    return { state: rejectedState, tasks, approved: false };
  };

  while (true) {
    if (opts.wctx.signal?.aborted) return { state, tasks, approved: false };
    const result = await opts.wctx.callbacks.onApprovalNeeded('briefs', tasksFilePath);
    if (opts.wctx.signal?.aborted) return { state, tasks, approved: false };

    const warnDropped = (message: string) =>
      publishWarning({ bus: opts.wctx.bus, phase: state.phase, message: message });

    if (result.action === 'edit') {
      const edited = await readApprovedSplitTasks(tasksFilePath, warnDropped);
      if (!edited.ok) {
        publishError({
          bus: opts.wctx.bus,
          phase: state.phase,
          message: `Auto-split overflow review failed: ${edited.message}`,
        });
        if (tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), edited.message))) {
          return rejectNoProgress();
        }
        continue;
      }
      const { ok, report } = runBriefQualityGate({
        tasks: edited.tasks,
        projectDir: opts.wctx.projectDir,
        sessionId: opts.wctx.sessionId,
        bus: opts.wctx.bus,
        phase: state.phase,
      });
      if (!ok) {
        publishError({
          bus: opts.wctx.bus,
          phase: state.phase,
          message: `Auto-split overflow review failed quality gate: ${firstBriefErrorMessage(report)}`,
        });
        if (
          tracker.registerFailure(
            briefReviewFingerprint(
              edited.tasks,
              briefsBody(),
              `quality:${firstBriefErrorMessage(report)}`,
            ),
          )
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      const editReadiness = await runBriefReadinessGateAndReport({
        tasks: edited.tasks,
        config: opts.wctx.config,
        projectDir: opts.wctx.projectDir,
        sessionId: opts.wctx.sessionId,
        bus: opts.wctx.bus,
        phase: state.phase,
        ...(opts.wctx.modelCache !== undefined && { modelCache: opts.wctx.modelCache }),
        ...(opts.wctx.detectedContextLength !== undefined && {
          detectedContextLength: opts.wctx.detectedContextLength,
        }),
      });
      if (!editReadiness.ok) {
        publishReadinessBlockWarning({
          bus: opts.wctx.bus,
          phase: state.phase,
          report: editReadiness,
        });
        if (
          tracker.registerFailure(
            briefReviewFingerprint(edited.tasks, briefsBody(), readinessBlockDetail(editReadiness)),
          )
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      tasks = edited.tasks;
      state = transitionAndSave(opts.wctx, state, {
        type: 'BRIEFS_READY',
        tasks,
      });
      opts.setTrackedState(state);
      continue;
    }

    if (!result.approved && result.action !== 'revise') {
      publishError({
        bus: opts.wctx.bus,
        phase: state.phase,
        message: 'Auto-split overflow rejected before implementation.',
      });
      state = transitionAndSave(opts.wctx, state, {
        type: 'REJECT_BRIEFS',
      });
      opts.setTrackedState(state);
      return { state, tasks, approved: false };
    }

    if (!result.approved) {
      const message = {
        id: randomUUID(),
        text: result.comment,
        queuedAt: nowIso(),
        phase: state.phase,
        deliveredViaNative: false as const,
        nativeDeliveryState: 'pending' as const,
      };
      state = transitionAndSave(opts.wctx, state, {
        type: 'ENQUEUE_USER_MSG',
        message,
      });
      opts.setTrackedState(state);

      const regen = await regenerateTasks({
        projectDir: opts.wctx.projectDir,
        sessionId: opts.wctx.sessionId,
        planner: opts.wctx.planner,
        callbacks: opts.wctx.callbacks,
        bus: opts.wctx.bus,
        state,
        metadata: opts.wctx.metadata,
        signal: opts.wctx.signal,
      });
      state = regen.state;
      tasks = regen.tasks;

      const { ok, report } = runBriefQualityGate({
        tasks,
        projectDir: opts.wctx.projectDir,
        sessionId: opts.wctx.sessionId,
        bus: opts.wctx.bus,
        phase: state.phase,
      });
      if (!ok) {
        createBusTextHandler({ bus: opts.wctx.bus, phase: state.phase })(
          `\n[Brief quality gate failed after regeneration: ${firstBriefErrorMessage(report)}. Please review and try again.]\n`,
        );
      }

      state = transitionAndSave(opts.wctx, state, {
        type: 'BRIEFS_READY',
        tasks,
      });
      opts.setTrackedState(state);
      continue;
    }

    const approvedTasksResult = await readApprovedSplitTasks(tasksFilePath, warnDropped);
    if (!approvedTasksResult.ok) {
      publishError({
        bus: opts.wctx.bus,
        phase: state.phase,
        message: `Auto-split overflow review failed: ${approvedTasksResult.message}`,
      });
      if (
        tracker.registerFailure(
          briefReviewFingerprint(tasks, briefsBody(), approvedTasksResult.message),
        )
      ) {
        return rejectNoProgress();
      }
      continue;
    }
    const approvedTasks = approvedTasksResult.tasks;

    const { ok, report } = runBriefQualityGate({
      tasks: approvedTasks,
      projectDir: opts.wctx.projectDir,
      sessionId: opts.wctx.sessionId,
      bus: opts.wctx.bus,
      phase: state.phase,
    });
    if (!ok) {
      publishError({
        bus: opts.wctx.bus,
        phase: state.phase,
        message: `Auto-split overflow review failed quality gate: ${firstBriefErrorMessage(report)}`,
      });
      if (
        tracker.registerFailure(
          briefReviewFingerprint(
            approvedTasks,
            briefsBody(),
            `quality:${firstBriefErrorMessage(report)}`,
          ),
        )
      ) {
        return rejectNoProgress();
      }
      continue;
    }
    const readiness = await runBriefReadinessGateAndReport({
      tasks: approvedTasks,
      config: opts.wctx.config,
      projectDir: opts.wctx.projectDir,
      sessionId: opts.wctx.sessionId,
      bus: opts.wctx.bus,
      phase: state.phase,
      ...(opts.wctx.modelCache !== undefined && { modelCache: opts.wctx.modelCache }),
      ...(opts.wctx.detectedContextLength !== undefined && {
        detectedContextLength: opts.wctx.detectedContextLength,
      }),
    });
    if (!readiness.ok) {
      const fingerprint = briefReviewFingerprint(
        approvedTasks,
        briefsBody(),
        readinessBlockDetail(readiness),
      );
      if (tracker.isOverrideOffered(fingerprint)) {
        recordReadinessOverride({
          projectDir: opts.wctx.projectDir,
          sessionId: opts.wctx.sessionId,
          bus: opts.wctx.bus,
          phase: state.phase,
          report: readiness,
        });
        tracker.reset();
      } else {
        tracker.offerOverride(fingerprint);
        publishReadinessBlockWarning({
          bus: opts.wctx.bus,
          phase: state.phase,
          report: readiness,
        });
        if (tracker.registerFailure(fingerprint)) {
          return rejectNoProgress();
        }
        continue;
      }
    }

    state = transitionAndSave(opts.wctx, state, {
      type: 'BRIEFS_READY',
      tasks: approvedTasks,
    });
    state = transitionAndSave(opts.wctx, state, {
      type: 'APPROVE_BRIEFS',
    });
    opts.setTrackedState(state);
    return { state, tasks: approvedTasks, approved: true };
  }
}

export function formatSkippedSplitNotice(skippedSplits: AutoSplitOverflowSkippedSplit[]): string {
  return skippedSplits
    .map((skipped) => {
      const reason = skipped.reason.trim();
      const punctuatedReason = /[.!?]$/.test(reason) ? reason : `${reason}.`;
      return `Auto-split overflow skipped ${skipped.taskId}: ${punctuatedReason} Original task will continue unless routing/recovery requires a different action.`;
    })
    .join('; ');
}
