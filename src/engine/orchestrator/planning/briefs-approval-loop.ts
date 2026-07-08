import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EventBus } from '../../events/types.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { createBusTextHandler, publishError, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { nowIso } from '../../../utils/format-time.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import { labelError } from '../../../utils/format-errors.js';
import { firstBriefErrorMessage } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { firstBriefReadinessBlockMessage, runBriefReadinessGate } from './brief-readiness-gate.js';
import { regenerateTasks } from './regen.js';
import { buildTargetedRejectionComment } from './regen-targeted.js';
import { readPersistedTasks, readTasksForApproval } from './io.js';
import type { BriefsApprovalLoopOptions, BriefsApprovalLoopResult } from './types.js';
import { commitQueueMessagesDrained, readQueueForPrompt } from '../queue.js';
import { formatQueuedMessagePreview } from '../../../core/queue-preview.js';

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

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);

  const initialTasksFile = await readPersistedTasks(tasksFilePath);
  if (!initialTasksFile.ok && initialTasksFile.reason === 'missing' && tasks.length > 0) {
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(tasks), metadata);
  }

  const pendingQueue = readQueueForPrompt({ projectDir, sessionId, state });
  state = pendingQueue.state;
  if (pendingQueue.messages.length > 0) {
    createBusTextHandler({ bus, phase: state.phase })(
      '\n[Applying queued input before Task Brief review]\n',
    );
    const regen = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state,
      metadata,
      signal,
      queuedMessages: pendingQueue.messages,
      commitQueue: false,
      statusPhase: 'planning',
      statusSummary: 'applying queued input before Task Brief review',
      sinks: opts.sinks,
    });
    state = regen.state;
    tasks = regen.tasks;

    const { report, ok } = runBriefQualityGate({
      tasks,
      projectDir,
      sessionId,
      bus,
      phase: state.phase,
    });
    if (ok) {
      state = commitBriefQueue({ projectDir, sessionId, state, bus }, regen.queuedMessages);
    } else {
      publishBriefQualityFailure(bus, state.phase, report);
    }
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });

  while (true) {
    if (signal?.aborted) return { state, tasks, rejected: false, aborted: true };
    const result = await callbacks.onApprovalNeeded('briefs', tasksFilePath);
    if (signal?.aborted) return { state, tasks, rejected: false, aborted: true };

    const warnDropped = (message: string) =>
      publishWarning({ bus, phase: state.phase, message: message });

    if (result.action === 'edit') {
      const edited = await readPersistedTasks(tasksFilePath, warnDropped);
      if (!edited.ok) {
        publishError({ bus: bus, phase: state.phase, message: edited.message });
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
        continue;
      }
      const editReadiness = await runBriefReadinessGate({
        tasks: edited.tasks,
        config,
        projectDir,
      });
      if (!editReadiness.ok) {
        publishError({
          bus: bus,
          phase: state.phase,
          message: firstBriefReadinessBlockMessage(editReadiness),
        });
        continue;
      }
      tasks = edited.tasks;
      if (tasks.length < 1) {
        publishError({
          bus,
          phase: state.phase,
          message: 'Task Brief set must retain at least one task.',
        });
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
        continue;
      }
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
      continue;
    }

    if (!result.approved && result.action !== 'revise') {
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'REJECT_BRIEFS' });
      return { state, tasks, rejected: true };
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
        continue;
      }
      const { report, ok } = runBriefQualityGate({
        tasks: approved.tasks,
        projectDir,
        sessionId,
        bus,
        phase: state.phase,
      });
      if (!ok) {
        publishBriefQualityFailure(bus, state.phase, report);
        continue;
      }
      const readiness = await runBriefReadinessGate({
        tasks: approved.tasks,
        config,
        projectDir,
      });
      if (!readiness.ok) {
        publishError({
          bus: bus,
          phase: state.phase,
          message: firstBriefReadinessBlockMessage(readiness),
        });
        continue;
      }
      tasks = approved.tasks;
      if (tasks.length < 1) {
        publishError({
          bus,
          phase: state.phase,
          message: 'Task Brief set must retain at least one task.',
        });
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
        continue;
      }
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'APPROVE_BRIEFS' });
      return { state, tasks, rejected: false };
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
      continue;
    }
    tasks = revised.tasks;
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });

    const revision = getBriefRevisionComment(result, tasks);
    if (!revision.ok) {
      publishError({ bus: bus, phase: state.phase, message: revision.message });
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

    const regen = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state,
      metadata,
      signal,
      commitQueue: false,
      statusPhase: 'planning',
      statusSummary: 'regenerating Task Briefs from feedback',
      sinks: opts.sinks,
    });
    state = regen.state;
    tasks = regen.tasks;

    const { report, ok } = runBriefQualityGate({
      tasks,
      projectDir,
      sessionId,
      bus,
      phase: state.phase,
    });
    if (!ok) {
      createBusTextHandler({ bus: bus, phase: state.phase })(
        `\n[Brief quality gate failed after regeneration: ${firstBriefErrorMessage(report)}. Please review and try again.]\n`,
      );
    } else {
      state = commitBriefQueue({ projectDir, sessionId, state, bus }, regen.queuedMessages);
    }

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

function commitBriefQueue(
  ctx: { projectDir: string; sessionId: string; state: WorkflowState; bus: EventBus },
  messages: readonly QueuedMessage[],
): WorkflowState {
  return commitQueueMessagesDrained({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    state: ctx.state,
    messages,
    bus: ctx.bus,
  }).state;
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
