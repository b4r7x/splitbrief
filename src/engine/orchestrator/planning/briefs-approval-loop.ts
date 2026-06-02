import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { EventBus } from '../../events/types.js';
import { createBusTextHandler, publishError } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { nowIso } from '../../../utils/format-time.js';
import { isENOENT } from '../../../lib/process/errors.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { firstBriefErrorMessage } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { runBriefQualityGate } from './planning-helpers.js';
import { regenerateTasks } from './regen.js';
import { readPersistedTasks, readTasksForApproval } from './planning-io.js';
import type { BriefsApprovalLoopOptions, BriefsApprovalLoopResult } from './types.js';

function publishBriefQualityFailure(bus: EventBus, phase: Phase, report: BriefQualityReport): void {
  publishError(
    { bus: bus, phase: phase },
    `Task Brief quality gate failed: ${firstBriefErrorMessage(report)}`,
  );
}

export async function runBriefsApprovalLoop(
  opts: BriefsApprovalLoopOptions,
): Promise<BriefsApprovalLoopResult> {
  const { planner, projectDir, sessionId, callbacks, bus, metadata, signal } = opts;
  let { state, tasks } = opts;

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);

  try {
    await readFile(tasksFilePath, 'utf8');
  } catch (err) {
    if (isENOENT(err) && tasks.length > 0) {
      writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(tasks), metadata);
    }
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });

  while (true) {
    if (signal?.aborted) return { state, tasks, rejected: false };
    const result = await callbacks.onApprovalNeeded('briefs', tasksFilePath);
    if (signal?.aborted) return { state, tasks, rejected: false };

    if (result.action === 'edit') {
      const edited = await readPersistedTasks(tasksFilePath);
      if (!edited.ok) {
        publishError({ bus: bus, phase: state.phase }, edited.message);
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
      tasks = edited.tasks;
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
      continue;
    }

    if (!result.approved && !result.comment) {
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'REJECT_BRIEFS' });
      return { state, tasks, rejected: true };
    }

    if (!result.comment) {
      const approved = await readTasksForApproval({
        tasksFilePath,
        currentTasks: tasks,
        projectDir,
        sessionId,
        metadata,
      });
      if (!approved.ok) {
        publishError({ bus: bus, phase: state.phase }, approved.message);
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
      tasks = approved.tasks;
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'APPROVE_BRIEFS' });
      return { state, tasks, rejected: false };
    }

    const message = {
      id: randomUUID(),
      text: result.comment,
      queuedAt: nowIso(),
      phase: state.phase,
      deliveredViaNative: false as const,
    };
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'ENQUEUE_USER_MSG',
      message,
    });

    const regen = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state,
      metadata,
      signal,
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
    }

    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEFS_READY', tasks });
  }
}
