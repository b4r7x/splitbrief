import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { RecoveryResultV1 } from '../../../core/schemas/brief-recovery.js';
import type { WorkflowContext } from '../types.js';
import type { AutoSplitOverflowSkippedSplit } from '../auto-split-overflow.js';
import { publishError, publishWarning } from '../events.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { formatTasks } from '../../spec/formatter.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { runBriefsApprovalLoop } from '../planning/briefs-approval-loop.js';
import type { PhaseRecoveryBinding } from './phases.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import {
  parkedPlanningResult,
  planningResultForState,
  terminalPlanningResult,
} from '../planning/handoff.js';
import { commitWorkflowState, readWorkflowStateHead } from '../state-ops.js';

export async function reviewAutoSplitOutput(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  tasks: Task[];
  setTrackedState: (s: WorkflowState) => void;
  recovery: PhaseRecoveryBinding & {
    createAdmissionInput: NonNullable<PhaseRecoveryBinding['createAdmissionInput']>;
  };
}): Promise<PlanningPhaseResult> {
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

  const recovery = opts.recovery;
  const ref = { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId };
  const current = recovery.readState();
  const resetForAdmission: WorkflowState = {
    ...current,
    phase: 'reviewing-briefs',
    tasks: [...opts.tasks],
    currentTaskIndex: 0,
    attempt: 0,
    authorityRevision: undefined,
    generation: null,
    permit: null,
    briefRecovery: null,
  };
  const head = readWorkflowStateHead(ref);
  let admissionState = resetForAdmission;
  if (head !== null) {
    const committed = commitWorkflowState({ ref, expected: current, next: resetForAdmission });
    if (committed.kind !== 'committed') {
      opts.setTrackedState(current);
      return parkedPlanningResult(opts.wctx.sessionId, current, recovery.projection);
    }
    admissionState = committed.state;
  }
  recovery.writeState(admissionState);
  opts.setTrackedState(admissionState);

  let admission: RecoveryResultV1;
  try {
    admission = await recovery.controller.enterBriefAdmission(
      recovery.createAdmissionInput({
        tasks: opts.tasks,
        state: admissionState,
        projectDir: opts.wctx.projectDir,
        sessionId: opts.wctx.sessionId,
      }),
      recovery.authority,
    );
  } catch {
    const state = recovery.readState();
    opts.setTrackedState(state);
    return parkedPlanningResult(opts.wctx.sessionId, state, recovery.projection);
  }

  if (admission.kind === 'rejected') {
    const state = recovery.readState();
    opts.setTrackedState(state);
    return terminalPlanningResult(state, 'rejected');
  }

  const loop = await runBriefsApprovalLoop({
    tasks: opts.tasks,
    qualityValidatedTasks: opts.tasks,
    planner: opts.wctx.planner,
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    callbacks: opts.wctx.callbacks,
    bus: opts.wctx.bus,
    state: recovery.readState(),
    config: opts.wctx.config,
    metadata: opts.wctx.metadata,
    ...(opts.wctx.signal !== undefined ? { signal: opts.wctx.signal } : {}),
    ...(opts.wctx.sinks !== undefined ? { sinks: opts.wctx.sinks } : {}),
    ...(opts.wctx.modelCache !== undefined ? { modelCache: opts.wctx.modelCache } : {}),
    ...(opts.wctx.detectedContextLength !== undefined
      ? { detectedContextLength: opts.wctx.detectedContextLength }
      : {}),
    recovery: {
      controller: recovery.controller,
      authority: recovery.authority,
      projection: admission.projection,
      admission,
      readState: recovery.readState,
      writeState: recovery.writeState,
    },
  });

  const state = recovery.readState();
  opts.setTrackedState(state);
  if (loop.outcome === 'rejected') {
    publishError({
      bus: opts.wctx.bus,
      phase: state.phase,
      message: 'Auto-split overflow rejected before implementation.',
    });
  }
  switch (loop.outcome) {
    case 'accepted':
      return planningResultForState({
        sessionId: opts.wctx.sessionId,
        state,
        projection: recovery.projection,
        tasks: loop.tasks,
      });
    case 'rejected':
      return terminalPlanningResult(state, 'rejected');
    case 'aborted':
      return terminalPlanningResult(state, 'cancelled');
    case 'failed':
      return parkedPlanningResult(opts.wctx.sessionId, state, recovery.projection);
    default: {
      const exhaustive: never = loop.outcome;
      return exhaustive;
    }
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
