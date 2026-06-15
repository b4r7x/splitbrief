import type { Task } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';
import { countBySeverity } from '../../../utils/collections.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { writeSpecFile, type SpecFileRef } from '../../../core/paths-io.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';

export function writeBriefQuality(ref: SpecFileRef, report: BriefQualityReport): void {
  writeSpecFile(ref, BRIEF_QUALITY_FILE, JSON.stringify(report, null, 2), null);
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
  writeBriefQuality({ projectDir, sessionId }, report);
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
