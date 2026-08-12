import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EventBus } from '../../events/types.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { publishError, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { nowIso } from '../../../utils/format-time.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import { labelError } from '../../../utils/format-errors.js';
import { firstBriefErrorMessage } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { runBriefReadinessGateAndReport } from './brief-readiness-gate.js';
import {
  MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS,
  briefReviewFingerprint,
  createBriefReviewTracker,
  publishReadinessBlockWarning,
  readinessBlockDetail,
  recordReadinessOverride,
} from './brief-review-gate.js';
import { buildTargetedRejectionComment } from './regen-targeted.js';
import { readPersistedTasks, readTasksForApproval } from './io.js';
import type { BriefsApprovalLoopOptions, BriefsApprovalLoopResult } from './types.js';
import { formatQueuedMessagePreview } from '../../../core/queue-preview.js';
import type { PlannerCallbacksContext } from '../types.js';
import { prepareQueuedBriefs } from './briefs-approval-queue.js';

function publishBriefQualityFailure(bus: EventBus, phase: Phase, report: BriefQualityReport): void {
  publishError({
    bus: bus,
    phase: phase,
    message: `Task Brief quality gate failed: ${firstBriefErrorMessage(report)}`,
  });
}

export async function runBriefsApprovalLoop(
  opts: BriefsApprovalLoopOptions,
): Promise<BriefsApprovalLoopResult> {
  const { planner, projectDir, sessionId, callbacks, bus, config, metadata, signal } = opts;
  let { state, tasks } = opts;
  let lastQualityPassingTasksSignature =
    opts.qualityValidatedTasks === undefined ? undefined : formatTasks(opts.qualityValidatedTasks);

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
  const plannerContext: PlannerCallbacksContext = {
    projectDir,
    sessionId,
    config,
    callbacks,
    bus,
    metadata,
    signal,
    sinks: opts.sinks ?? {
      setAbortHandler: () => {},
      setQueueHandler: () => {},
    },
    ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
    ...(opts.detectedContextLength !== undefined && {
      detectedContextLength: opts.detectedContextLength,
    }),
  };

  const initialTasksFile = await readPersistedTasks(tasksFilePath);
  if (!initialTasksFile.ok && initialTasksFile.reason === 'missing' && tasks.length > 0) {
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(tasks), metadata);
  }

  const queuedPreparation = await prepareQueuedBriefs({
    tasks,
    state,
    planner,
    wctx: plannerContext,
    qualityValidatedTasks: opts.qualityValidatedTasks,
  });
  if (queuedPreparation.kind === 'failed') {
    return queuedPreparation.result;
  }
  state = queuedPreparation.state;
  if (queuedPreparation.kind === 'prepared') {
    tasks = queuedPreparation.tasks;
    lastQualityPassingTasksSignature = formatTasks(tasks);
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });

  const tracker = createBriefReviewTracker();

  const briefsBody = (): string => readSpecFile({ projectDir, sessionId }, TASKS_FILE) ?? '';

  const rejectNoProgress = (): BriefsApprovalLoopResult => {
    publishError({
      bus: bus,
      phase: state.phase,
      message: `Task Brief review made no progress after ${MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS} consecutive attempts; rejecting the Task Briefs.`,
      safety: { category: 'workflow', code: 'brief_review_no_progress', transcriptSafe: true },
    });
    const rejectedState = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'REJECT_BRIEFS',
    });
    return { state: rejectedState, tasks, rejected: true, failed: false };
  };

  while (true) {
    if (signal?.aborted) return { state, tasks, rejected: false, failed: false, aborted: true };
    const result = await callbacks.onApprovalNeeded('briefs', tasksFilePath);
    if (signal?.aborted) return { state, tasks, rejected: false, failed: false, aborted: true };

    const warnDropped = (message: string) =>
      publishWarning({ bus, phase: state.phase, message: message });

    if (result.action === 'edit') {
      const edited = await readPersistedTasks(tasksFilePath, warnDropped);
      if (!edited.ok) {
        publishError({ bus: bus, phase: state.phase, message: edited.message });
        if (tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), edited.message))) {
          return rejectNoProgress();
        }
        continue;
      }
      const { report, ok } = runBriefQualityGate({
        tasks: edited.tasks,
        projectDir,
        sessionId,
        bus,
        phase: state.phase,
      });
      if (!ok) {
        publishBriefQualityFailure(bus, state.phase, report);
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
      lastQualityPassingTasksSignature = formatTasks(edited.tasks);
      const editReadiness = await runBriefReadinessGateAndReport({
        tasks: edited.tasks,
        config,
        projectDir,
        sessionId,
        bus,
        phase: state.phase,
        ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
        ...(opts.detectedContextLength !== undefined && {
          detectedContextLength: opts.detectedContextLength,
        }),
      });
      if (!editReadiness.ok) {
        publishReadinessBlockWarning({ bus, phase: state.phase, report: editReadiness });
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
      if (tasks.length < 1) {
        publishError({
          bus,
          phase: state.phase,
          message: 'Task Brief set must retain at least one task.',
        });
        if (
          tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), 'empty-task-set'))
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      try {
        topoSort(tasks);
      } catch (err) {
        publishError({
          bus,
          phase: state.phase,
          message: labelError('Task Brief dependency graph is invalid', err),
        });
        if (
          tracker.registerFailure(
            briefReviewFingerprint(tasks, briefsBody(), labelError('topo-sort', err)),
          )
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
      continue;
    }

    if (!result.approved && result.action !== 'revise') {
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'REJECT_BRIEFS' });
      return { state, tasks, rejected: true, failed: false };
    }

    if (result.approved) {
      const approved = await readTasksForApproval({
        tasksFilePath,
        currentTasks: tasks,
        projectDir,
        sessionId,
        metadata,
      });
      if (!approved.ok) {
        publishError({ bus: bus, phase: state.phase, message: approved.message });
        if (
          tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), approved.message))
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      const approvedTasksSignature = formatTasks(approved.tasks);
      if (approvedTasksSignature !== lastQualityPassingTasksSignature) {
        const { report, ok } = runBriefQualityGate({
          tasks: approved.tasks,
          projectDir,
          sessionId,
          bus,
          phase: state.phase,
        });
        if (!ok) {
          publishBriefQualityFailure(bus, state.phase, report);
          if (
            tracker.registerFailure(
              briefReviewFingerprint(
                approved.tasks,
                briefsBody(),
                `quality:${firstBriefErrorMessage(report)}`,
              ),
            )
          ) {
            return rejectNoProgress();
          }
          continue;
        }
        lastQualityPassingTasksSignature = approvedTasksSignature;
      }
      const readiness = await runBriefReadinessGateAndReport({
        tasks: approved.tasks,
        config,
        projectDir,
        sessionId,
        bus,
        phase: state.phase,
        ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
        ...(opts.detectedContextLength !== undefined && {
          detectedContextLength: opts.detectedContextLength,
        }),
      });
      if (!readiness.ok) {
        const fingerprint = briefReviewFingerprint(
          approved.tasks,
          briefsBody(),
          readinessBlockDetail(readiness),
        );
        if (tracker.isOverrideOffered(fingerprint)) {
          recordReadinessOverride({
            projectDir,
            sessionId,
            bus,
            phase: state.phase,
            report: readiness,
          });
          tracker.reset();
        } else {
          tracker.offerOverride(fingerprint);
          publishReadinessBlockWarning({ bus, phase: state.phase, report: readiness });
          if (tracker.registerFailure(fingerprint)) {
            return rejectNoProgress();
          }
          continue;
        }
      }
      tasks = approved.tasks;
      if (tasks.length < 1) {
        publishError({
          bus,
          phase: state.phase,
          message: 'Task Brief set must retain at least one task.',
        });
        if (
          tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), 'empty-task-set'))
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      try {
        topoSort(tasks);
      } catch (err) {
        publishError({
          bus,
          phase: state.phase,
          message: labelError('Task Brief dependency graph is invalid', err),
        });
        if (
          tracker.registerFailure(
            briefReviewFingerprint(tasks, briefsBody(), labelError('topo-sort', err)),
          )
        ) {
          return rejectNoProgress();
        }
        continue;
      }
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'APPROVE_BRIEFS' });
      return { state, tasks, rejected: false, failed: false };
    }

    const revised = await readTasksForApproval({
      tasksFilePath,
      currentTasks: tasks,
      projectDir,
      sessionId,
      metadata,
      onWarning: warnDropped,
    });
    if (!revised.ok) {
      publishError({ bus: bus, phase: state.phase, message: revised.message });
      if (tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), revised.message))) {
        return rejectNoProgress();
      }
      continue;
    }
    tasks = revised.tasks;

    const revision = getBriefRevisionComment(result, tasks);
    if (!revision.ok) {
      publishError({ bus: bus, phase: state.phase, message: revision.message });
      if (tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), revision.message))) {
        return rejectNoProgress();
      }
      continue;
    }
    const comment = revision.comment;
    const message = {
      id: randomUUID(),
      text: comment,
      queuedAt: nowIso(),
      phase: state.phase,
      deliveredViaNative: false as const,
      nativeDeliveryState: 'pending' as const,
    };
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'ENQUEUE_USER_MSG',
      message,
    });
    publishQueuedBriefFeedback(bus, state.phase, message);

    const quality = await prepareQueuedBriefs({
      tasks,
      state,
      planner,
      wctx: plannerContext,
    });
    if (quality.kind === 'failed') {
      return {
        state: quality.result.state,
        tasks: quality.result.tasks,
        rejected: false,
        failed: quality.result.failed,
        ...(quality.result.aborted && { aborted: true }),
      };
    }
    state = quality.state;
    tasks = quality.tasks;
    lastQualityPassingTasksSignature = formatTasks(tasks);
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
  }
}

function getBriefRevisionComment(
  result: Extract<ApprovalReviewResult, { approved: false; action: 'revise' }>,
  tasks: Task[],
): { ok: true; comment: string } | { ok: false; message: string } {
  if (result.taskIds === undefined || result.taskIds.length === 0) {
    return { ok: true, comment: result.comment };
  }
  const requestedIds = new Set(result.taskIds);
  const knownIds = new Set(tasks.map((task) => task.id));
  const unknownIds = [...requestedIds].filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      message: `Unknown Task Brief ID${unknownIds.length === 1 ? '' : 's'} for targeted revision: ${unknownIds.join(', ')}`,
    };
  }
  const flaggedTasks = tasks.filter((task) => requestedIds.has(task.id));
  return { ok: true, comment: buildTargetedRejectionComment(flaggedTasks, result.comment) };
}

function publishQueuedBriefFeedback(bus: EventBus, phase: Phase, message: QueuedMessage): void {
  const preview = formatQueuedMessagePreview(message);
  bus.publish({
    type: 'message_queued',
    ts: Date.now(),
    phase,
    id: message.id,
    ...(preview.length > 0 && { preview }),
  });
}
