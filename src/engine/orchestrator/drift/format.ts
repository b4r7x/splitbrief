import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { countBySeverity } from '../../../utils/collections.js';
import type { DriftReport } from '../../../core/schemas/drift.js';

export function formatDriftReportForPrompt(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(`passed: ${report.passed}`);
  lines.push(`score: ${report.score.toFixed(2)}`);
  if (report.findings.length === 0) {
    lines.push('findings: none');
  } else {
    lines.push('findings:');
    for (const f of report.findings) {
      lines.push(`- [${f.severity}] ${f.code}: ${f.message}`);
    }
  }
  return lines.join('\n');
}

export function publishDriftReport(bus: EventBus, phase: Phase, report: DriftReport): void {
  const { error: errorCount, warning: warningCount } = countBySeverity(report.findings);
  const event: EngineEvent = {
    type: 'drift_report',
    ts: Date.now(),
    phase,
    passed: report.passed,
    score: report.score,
    errorCount,
    warningCount,
  };
  bus.publish(event);
}
