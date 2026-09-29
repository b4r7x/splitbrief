import type { WorkflowState, QueuedMessage } from '../../../core/schemas/workflow.js';
import type { Planner } from '../../planners/types.js';
import { BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { readSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import { briefErrorMessages } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import { splitTaskBlocks } from '../../spec/tasks/blocks.js';
import { createBusTextHandler } from '../events.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { buildBriefQualityRepairComment } from './regen-targeted.js';
import { regenerateTasks } from './regen.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { countBySeverity } from '../../../utils/collections.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { detectStack } from '../../../core/validation/stacks/registry.js';
import { briefQualityReportBytes, writeBriefQualityReport } from '../../spec/brief-quality-file.js';
import type { BriefQualityCode, BriefQualityReport } from '../../spec/brief-quality.js';

export type BriefQualityGateIssue = {
  taskId: TaskId;
  severity: 'error' | 'warning';
  code: BriefQualityCode;
  message: string;
};

export type BriefQualityGateReport = Omit<BriefQualityReport, 'issues'> & {
  issues: BriefQualityGateIssue[];
};

export type BriefQualityGateResult = {
  report: BriefQualityGateReport;
  errorCount: number;
  warningCount: number;
  ok: boolean;
};

export function runBriefQualityGate(input: {
  tasks: Task[];
  projectDir: string;
}): BriefQualityGateResult {
  const evaluated = evaluateBriefQuality(input.tasks, detectStack(input.projectDir));
  const issues: BriefQualityGateIssue[] = evaluated.issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    taskId: issue.taskId,
    message: issue.message,
  }));
  const report: BriefQualityGateReport = {
    version: 1,
    passed: evaluated.passed,
    score: evaluated.score,
    issues,
  };
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  return { report, errorCount, warningCount, ok: errorCount === 0 };
}

export function runQualityGateAndReport(input: {
  tasks: Task[];
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  /**
   * The briefs are the ones `brief-quality.json` already measured. The report carries the
   * briefs' `briefHash`, so a passing report that leaves the file as it was is written again
   * but not announced again: the transcript shows it. A report written for other briefs, or
   * one that predates the identity and carries no hash, cannot suppress the pass.
   */
  sameBriefs?: boolean | undefined;
}): BriefQualityGateResult {
  const ref = { projectDir: input.projectDir, sessionId: input.sessionId };
  const result = runBriefQualityGate({ tasks: input.tasks, projectDir: input.projectDir });
  const content = { issues: result.report.issues, briefHash: hashTaskBrief(input.tasks) };
  const unchanged =
    input.sameBriefs === true &&
    readSpecFile(ref, BRIEF_QUALITY_FILE) === briefQualityReportBytes(content);
  writeBriefQualityReport({ ref, content, metadata: null });
  if (result.ok && unchanged) return result;
  const counts = countBySeverity(result.report.issues);
  if (result.ok) {
    input.bus.publish({
      type: 'brief_quality_passed',
      ts: Date.now(),
      phase: input.phase,
      score: result.report.score,
      warningCount: counts.warning,
    });
  } else {
    input.bus.publish({
      type: 'brief_quality_failed',
      ts: Date.now(),
      phase: input.phase,
      score: result.report.score,
      errorCount: counts.error,
      warningCount: counts.warning,
    });
  }
  return result;
}

export type BriefQualityRepairOptions = {
  tasks: Task[];
  state: WorkflowState;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  metadata: SpecMetadata;
  maxRetries: number;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  queuedMessages?: readonly QueuedMessage[] | undefined;
};

export type BriefQualityRepairResult = {
  state: WorkflowState;
  tasks: Task[];
  report: BriefQualityGateReport;
  attempts: number;
  /** The planner replaced the briefs it was given, which no file holds yet. */
  regenerated: boolean;
};

export async function runBriefQualityWithRepair(
  opts: BriefQualityRepairOptions,
): Promise<BriefQualityRepairResult> {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const pending =
    opts.queuedMessages === undefined
      ? readQueueForPrompt({ ...ref, state: opts.state })
      : { state: opts.state, messages: [...opts.queuedMessages] };

  let state = pending.state;
  let tasks = opts.tasks;
  let queued: readonly QueuedMessage[] = pending.messages;
  let regenerated = false;

  const regenerate = async (feedback: string | undefined, summary: string): Promise<void> => {
    createBusTextHandler({ bus: opts.bus, phase: state.phase })(`\n[${summary}]\n`);
    try {
      const next = await regenerateTasks({
        ...ref,
        planner: opts.planner,
        callbacks: opts.callbacks,
        bus: opts.bus,
        state,
        metadata: opts.metadata,
        queuedMessages: queued,
        commitQueue: false,
        statusPhase: 'planning',
        statusSummary: summary,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts.sinks === undefined ? {} : { sinks: opts.sinks }),
        ...(feedback === undefined ? {} : { feedback }),
      });
      state = next.state;
      tasks = next.tasks;
      queued = next.queuedMessages;
      regenerated = true;
    } catch (err) {
      releaseQueueMessagesForPrompt(ref, queued);
      throw err;
    }
  };

  if (queued.length > 0) {
    await regenerate(undefined, 'applying queued input before the brief quality gate');
  }

  let result = runQualityGateAndReport({ ...ref, tasks, bus: opts.bus, phase: state.phase });
  let attempts = 1;
  while (!result.ok && attempts <= opts.maxRetries) {
    const fenceWarnings: string[] = [];
    splitTaskBlocks(formatTasks(tasks), (warning) => fenceWarnings.push(warning));
    await regenerate(
      buildBriefQualityRepairComment({
        errorMessages: briefErrorMessages(result.report),
        fenceWarnings,
      }),
      'regenerating Task Briefs to clear the brief quality gate',
    );
    result = runQualityGateAndReport({ ...ref, tasks, bus: opts.bus, phase: state.phase });
    attempts += 1;
  }

  if (queued.length > 0) {
    try {
      state = commitQueueMessagesDrained({
        ...ref,
        state,
        messages: queued,
        bus: opts.bus,
      }).state;
    } finally {
      releaseQueueMessagesForPrompt(ref, queued);
    }
  }

  return { state, tasks, report: result.report, attempts, regenerated };
}
