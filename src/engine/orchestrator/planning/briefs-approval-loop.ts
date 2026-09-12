import { join } from 'node:path';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { createBusTextHandler, publishError, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import { labelError } from '../../../utils/format-errors.js';
import { firstBriefError, type BriefQualityReport } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import { runQualityGateAndReport } from './brief-quality-gate.js';
import { runBriefReadinessGateAndReport } from './brief-readiness-gate.js';
import {
  MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS,
  briefReviewFingerprint,
  createBriefReviewTracker,
  publishReadinessBlockWarning,
  readinessBlockDetail,
  recordReadinessOverride,
} from './brief-review-gate.js';
import { regenerateTasks } from './regen.js';
import { buildTargetedRejectionComment } from './regen-targeted.js';
import { readPersistedTasks, readTasksForApproval } from './io.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import { driftedCompilerReceipt } from '../../runners/compiler-drift-warning.js';
import { recordRuntimeConformance } from '../../runners/runtime-conformance-cache.js';
import type { BriefsApprovalLoopOptions, BriefsApprovalLoopResult } from './types.js';

function isApprovalDecision(value: unknown): value is ApprovalReviewResult {
  if (typeof value !== 'object' || value === null) return false;
  if (!('approved' in value) || typeof value.approved !== 'boolean') return false;
  if (value.approved) return true;
  const action = 'action' in value ? value.action : undefined;
  if (action === undefined || action === 'edit') return true;
  return action === 'revise' && 'comment' in value && typeof value.comment === 'string';
}

function isEditDecision(
  result: ApprovalReviewResult,
): result is Extract<ApprovalReviewResult, { action: 'edit' }> {
  return !result.approved && 'action' in result && result.action === 'edit';
}

function isRevisionDecision(
  result: ApprovalReviewResult,
): result is Extract<ApprovalReviewResult, { action: 'revise' }> {
  return !result.approved && 'action' in result && result.action === 'revise';
}

function firstBriefErrorMessage(report: BriefQualityReport): string {
  return firstBriefError(report)?.message ?? 'unknown error';
}

function publishBriefQualityFailure(
  bus: EventBus,
  phase: WorkflowState['phase'],
  report: BriefQualityReport,
): void {
  publishError({
    bus,
    phase,
    message: `Task Brief quality gate failed: ${firstBriefErrorMessage(report)}`,
  });
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

export async function runBriefsApprovalLoop(
  opts: BriefsApprovalLoopOptions,
): Promise<BriefsApprovalLoopResult> {
  const { planner, projectDir, sessionId, callbacks, bus, config, metadata, signal, sinks } = opts;
  let { state, tasks } = opts;
  const ref = { projectDir, sessionId };
  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);

  const briefsBody = (): string => readSpecFile(ref, TASKS_FILE) ?? '';

  const writeBriefs = (text: string): void => {
    writeAndPublishArtifacts({
      projectDir,
      sessionId,
      bus,
      phase: state.phase,
      metadata,
      items: [{ kind: 'task-briefs', text }],
    });
  };

  const readinessFor = (candidate: Task[]) =>
    runBriefReadinessGateAndReport({
      tasks: candidate,
      config,
      projectDir,
      sessionId,
      bus,
      phase: state.phase,
      ...(opts.modelCache === undefined ? {} : { modelCache: opts.modelCache }),
      ...(opts.detectedContextLength === undefined
        ? {}
        : { detectedContextLength: opts.detectedContextLength }),
    });

  state = transitionAndSave(ref, state, { type: 'BRIEF_ADMISSION_OPENED' });
  const tracker = createBriefReviewTracker();

  const rejectNoProgress = (): BriefsApprovalLoopResult => {
    publishError({
      bus,
      phase: state.phase,
      message: `Task Brief review made no progress after ${MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS} consecutive attempts; rejecting the Task Briefs.`,
      safety: { category: 'workflow', code: 'brief_review_no_progress' },
    });
    state = transitionAndSave(ref, state, { type: 'REJECT_BRIEFS' });
    return { state, tasks, outcome: 'rejected' };
  };

  const registerFailure = (detail: string): boolean =>
    tracker.registerFailure(briefReviewFingerprint(tasks, briefsBody(), detail));

  const qualityFor = (candidate: Task[]) =>
    runQualityGateAndReport({
      tasks: candidate,
      projectDir,
      sessionId,
      bus,
      phase: state.phase,
    });

  /** Re-measures the candidate briefs; 'reject' once the no-progress tracker has tripped. */
  const gateQuality = (candidate: Task[], detail: string): 'ok' | 'failed' | 'reject' => {
    const quality = qualityFor(candidate);
    if (quality.ok) {
      tracker.reset();
      return 'ok';
    }
    publishBriefQualityFailure(bus, state.phase, quality.report);
    return registerFailure(`quality:${detail}`) ? 'reject' : 'failed';
  };

  while (true) {
    if (signal?.aborted) return { state, tasks, outcome: 'aborted' };
    let decision: ApprovalReviewResult;
    try {
      const result = await callbacks.onApprovalNeeded('briefs', tasksFilePath);
      if (!isApprovalDecision(result)) {
        publishError({
          bus,
          phase: state.phase,
          message: 'Task Brief review received an invalid approval decision.',
          safety: {
            category: 'workflow',
            code: 'brief_review_invalid_decision',
          },
        });
        return { state, tasks, outcome: 'failed' };
      }
      decision = result;
    } catch (err) {
      publishError({
        bus,
        phase: state.phase,
        message: labelError('Task Brief review prompt failed', err),
      });
      return { state, tasks, outcome: 'failed' };
    }
    if (signal?.aborted) return { state, tasks, outcome: 'aborted' };

    if (isEditDecision(decision)) {
      const edited = await readPersistedTasks(tasksFilePath, (message) =>
        publishWarning({ bus, phase: state.phase, message }),
      );
      if (!edited.ok) {
        publishError({ bus, phase: state.phase, message: edited.message });
        if (registerFailure(edited.message)) return rejectNoProgress();
        continue;
      }
      const readiness = await readinessFor(edited.tasks);
      if (!readiness.ok) {
        publishReadinessBlockWarning({ bus, phase: state.phase, report: readiness });
        if (registerFailure(readinessBlockDetail(readiness))) return rejectNoProgress();
        continue;
      }
      tasks = edited.tasks;
      writeBriefs(briefsBody());
      const quality = qualityFor(tasks);
      if (!quality.ok) publishBriefQualityFailure(bus, state.phase, quality.report);
      if (registerFailure('edit-applied')) return rejectNoProgress();
      continue;
    }

    if (isRevisionDecision(decision)) {
      const revised = await readTasksForApproval({
        tasksFilePath,
        currentTasks: tasks,
        projectDir,
        sessionId,
        metadata,
        onWarning: (message) => publishWarning({ bus, phase: state.phase, message }),
      });
      if (!revised.ok) {
        publishError({ bus, phase: state.phase, message: revised.message });
        if (registerFailure(revised.message)) return rejectNoProgress();
        continue;
      }
      tasks = revised.tasks;
      const revision = getBriefRevisionComment(decision, tasks);
      if (!revision.ok) {
        publishError({ bus, phase: state.phase, message: revision.message });
        if (registerFailure(revision.message)) return rejectNoProgress();
        continue;
      }
      createBusTextHandler({ bus, phase: state.phase })(
        '\n[Applying Task Brief revision feedback]\n',
      );
      try {
        const regen = await regenerateTasks({
          ...ref,
          planner,
          callbacks,
          bus,
          state,
          metadata,
          ...(signal === undefined ? {} : { signal }),
          ...(sinks === undefined ? {} : { sinks }),
          feedback: revision.comment,
          commitQueue: true,
          statusPhase: 'planning',
          statusSummary: 'regenerating Task Briefs from feedback',
        });
        state = regen.state;
        tasks = regen.tasks;
      } catch (err) {
        publishError({
          bus,
          phase: state.phase,
          message: labelError('Task Brief regeneration failed', err),
        });
        return { state, tasks, outcome: 'failed' };
      }
      writeBriefs(formatTasks(tasks));
      const quality = qualityFor(tasks);
      if (!quality.ok) {
        createBusTextHandler({ bus, phase: state.phase })(
          `\n[Brief quality gate failed after revision: ${firstBriefErrorMessage(quality.report)}. Please review and try again.]\n`,
        );
        if (registerFailure(`quality:${firstBriefErrorMessage(quality.report)}`))
          return rejectNoProgress();
      } else {
        tracker.reset();
      }
      continue;
    }

    if (decision.approved) {
      const approved = await readTasksForApproval({
        tasksFilePath,
        currentTasks: tasks,
        projectDir,
        sessionId,
        metadata,
        onWarning: (message) => publishWarning({ bus, phase: state.phase, message }),
      });
      if (!approved.ok) {
        publishError({ bus, phase: state.phase, message: approved.message });
        if (registerFailure(approved.message)) return rejectNoProgress();
        continue;
      }
      const readiness = await readinessFor(approved.tasks);
      if (!readiness.ok) {
        const fingerprint = briefReviewFingerprint(
          approved.tasks,
          briefsBody(),
          readinessBlockDetail(readiness),
        );
        if (tracker.isOverrideOffered(fingerprint)) {
          recordReadinessOverride({ bus, phase: state.phase });
          tracker.reset();
        } else {
          tracker.offerOverride(fingerprint);
          publishReadinessBlockWarning({ bus, phase: state.phase, report: readiness });
          if (tracker.registerFailure(fingerprint)) return rejectNoProgress();
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
        if (registerFailure('empty-task-set')) return rejectNoProgress();
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
        if (registerFailure(labelError('topo-sort', err))) return rejectNoProgress();
        continue;
      }
      writeBriefs(formatTasks(tasks));
      const verdict = gateQuality(tasks, 'approved');
      if (verdict === 'reject') return rejectNoProgress();
      if (verdict === 'failed') continue;
      const receipt = driftedCompilerReceipt(planner);
      if (receipt !== null) {
        recordRuntimeConformance(projectDir, {
          backend: receipt.backend,
          version: receipt.runtimeVersion,
        });
      }
      state = transitionAndSave(ref, state, { type: 'BEGIN_IMPLEMENTATION' });
      return { state, tasks, outcome: 'accepted' };
    }

    state = transitionAndSave(ref, state, { type: 'REJECT_BRIEFS' });
    return { state, tasks, outcome: 'rejected' };
  }
}
