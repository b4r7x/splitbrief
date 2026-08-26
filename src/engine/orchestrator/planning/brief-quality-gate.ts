import type { BriefQualityIssue } from '../../../core/schemas/brief-recovery/primitives.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { countBySeverity } from '../../../utils/collections.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { writeBriefQualityReport } from '../../spec/brief-quality-file.js';
import type { BriefQualityCode, BriefQualityReport } from '../../spec/brief-quality.js';

/** A bounded core issue that remains assignable to legacy engine consumers. */
export type BriefQualityGateIssue = BriefQualityIssue & {
  taskId: TaskId;
  code: BriefQualityCode;
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

export function runBriefQualityGate(input: { tasks: Task[] }): BriefQualityGateResult {
  const evaluated = evaluateBriefQuality(input.tasks);
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

export function runLegacyQualityGate(input: {
  tasks: Task[];
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
}): BriefQualityGateResult {
  const result = runBriefQualityGate({ tasks: input.tasks });
  writeBriefQualityReport({
    ref: { projectDir: input.projectDir, sessionId: input.sessionId },
    content: { issues: result.report.issues },
    metadata: null,
  });
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
