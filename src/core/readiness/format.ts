import { pluralize } from '../../utils/pluralize.js';
import type { ReadinessReport, ReadinessSection, StartReadinessRecord } from './types.js';

function renderSectionLines(section: ReadinessSection): string[] {
  const lines: string[] = [];
  lines.push(`${section.title}:`);
  for (const check of section.checks) {
    lines.push(`  ${check.severity} ${check.id}: ${check.summary}`);
    for (const detail of check.details ?? []) {
      lines.push(`    ${detail}`);
    }
    if (check.fix) {
      lines.push(`    Fix: ${check.fix}`);
    }
  }
  return lines;
}

export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(
    `Run readiness: ${report.status} (${report.counts.blocker} blockers, ${report.counts.warning} warnings)`,
  );
  if (report.status === 'blocked') {
    lines.push(
      `Required action: ${report.nextAction.label}${report.nextAction.command ? ` (${report.nextAction.command})` : ''}`,
    );
  } else if (report.counts.warning > 0) {
    lines.push(
      `Advisory: ${report.counts.warning} ${pluralize(report.counts.warning, 'warning')}; start can continue.`,
    );
  } else {
    lines.push('Ready: no blockers or warnings.');
  }
  lines.push('');

  for (const section of report.sections) {
    if (section.checks.length === 0) continue;
    lines.push(...renderSectionLines(section));
  }

  return lines.join('\n');
}

export function formatReadinessBlockers(report: ReadinessReport): string {
  const blockerOnly = createBlockerOnlyReadinessReport(report);
  const lines: string[] = [];
  lines.push(`Run readiness: blocked (${blockerOnly.counts.blocker} blockers)`);
  lines.push(
    `Required action: ${blockerOnly.nextAction.label}${blockerOnly.nextAction.command ? ` (${blockerOnly.nextAction.command})` : ''}`,
  );
  lines.push('');

  for (const section of blockerOnly.sections) {
    lines.push(...renderSectionLines(section));
  }

  return lines.join('\n');
}

export function createBlockerOnlyReadinessReport(report: ReadinessReport): ReadinessReport {
  const sections = report.sections
    .map(blockerOnlySection)
    .filter((section): section is ReadinessSection => section !== null);

  return {
    ...report,
    counts: {
      ok: 0,
      info: 0,
      warning: 0,
      blocker: report.counts.blocker,
    },
    sections,
  };
}

export function readinessBlockerMessage(report: ReadinessReport): string {
  const blockers = report.sections.flatMap((section) =>
    section.checks.filter((check) => check.severity === 'blocker'),
  );
  if (blockers.length === 0) return 'Readiness blocked.';
  return blockers.map((check) => `${check.id}: ${check.summary}`).join('\n');
}

function blockerOnlySection(section: ReadinessSection): ReadinessSection | null {
  const checks = section.checks.filter((check) => check.severity === 'blocker');
  if (checks.length === 0) return null;
  return { ...section, checks };
}

export function createStartReadinessRecord(report: ReadinessReport): StartReadinessRecord {
  const checks = report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker' || check.severity === 'warning')
    .map((check) => ({
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
