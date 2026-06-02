import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { publishError } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { labelError } from '../../../utils/format-errors.js';
import { countBySeverity } from '../../../utils/collections.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { drainQueue, formatDrainedMessages } from '../queue.js';

export function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; prefix: string } {
  const drain = drainQueue(projectDir, sessionId, state, bus);
  if (drain.messages.length === 0) return { state, prefix: '' };
  return { state: drain.state, prefix: formatDrainedMessages(drain.messages) };
}

export function handlePlanningFailure(opts: {
  err: unknown;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  wctx: PlannerCallbacksContext;
}): { state: WorkflowState; tasks: Task[]; cancelled: true } {
  const { err, projectDir, sessionId, state, wctx } = opts;
  publishError({ bus: wctx.bus, phase: state.phase }, labelError('Planning failed', err));
  return {
    state: transitionAndSave({ projectDir, sessionId }, state, { type: 'CANCEL' }),
    tasks: [],
    cancelled: true,
  };
}

export function runBriefQualityGate(opts: {
  tasks: Task[];
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
}): { report: BriefQualityReport; ok: boolean } {
  const { tasks, projectDir, sessionId, bus, phase } = opts;
  const report = evaluateBriefQuality(tasks);
  writeSpecFile(
    { projectDir, sessionId },
    BRIEF_QUALITY_FILE,
    JSON.stringify(report, null, 2),
    null,
  );
  const { error: errorCount, warning: warningCount } = countBySeverity(report.issues);
  if (report.passed) {
    bus.publish({
      type: 'brief_quality_passed',
      ts: Date.now(),
      phase,
      score: report.score,
      warningCount,
    });
  } else {
    bus.publish({
      type: 'brief_quality_failed',
      ts: Date.now(),
      phase,
      score: report.score,
      errorCount,
      warningCount,
    });
  }
  return { report, ok: report.passed };
}
