import type { ReadinessCheck, ReadinessReport, StartReadinessRecord } from './types.js';

const SEVERITY_LABELS: Record<ReadinessCheck['severity'], string> = {
  ok: 'ok',
  info: 'info',
  warning: 'warning',
  blocker: 'blocker',
};

export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(`Run readiness: ${report.status} (${report.counts.blocker} blockers, ${report.counts.warning} warnings)`);
  lines.push(`Next action: ${report.nextAction.label}${report.nextAction.command ? ` (${report.nextAction.command})` : ''}`);
  lines.push('');

  for (const section of report.sections) {
    if (section.checks.length === 0) continue;
    lines.push(`${section.title}:`);
    for (const check of section.checks) {
      lines.push(`  ${SEVERITY_LABELS[check.severity]} ${check.id}: ${check.summary}`);
      for (const detail of check.details ?? []) {
        lines.push(`    ${detail}`);
      }
      if (check.fix) {
        lines.push(`    Fix: ${check.fix}`);
      }
    }
  }

  return lines.join('\n');
}

export function readinessBlockerMessage(report: ReadinessReport): string {
  const blockers = report.sections.flatMap(section =>
    section.checks.filter(check => check.severity === 'blocker'),
  );
  if (blockers.length === 0) return 'Readiness blocked.';
  return blockers.map(check => `${check.id}: ${check.summary}`).join('\n');
}

export function createStartReadinessRecord(report: ReadinessReport): StartReadinessRecord {
  const checks = report.sections
    .flatMap(section => section.checks)
    .filter(check => check.severity === 'blocker' || check.severity === 'warning')
    .map(check => ({
      id: check.id,
      severity: check.severity,
      summary: check.summary,
    }));

  return {
    type: 'start-readiness',
    generatedAt: report.generatedAt,
    status: report.status,
    nextAction: report.nextAction.kind,
    blockerCount: report.counts.blocker,
    warningCount: report.counts.warning,
    checks,
  };
}
