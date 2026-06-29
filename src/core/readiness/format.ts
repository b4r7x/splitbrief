import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { countNoun } from '../../utils/pluralize.js';
import { StartReadinessRecordSchema, type StartReadinessRecord } from '../schemas/readiness.js';
import type { ReadinessReport, ReadinessSection } from './types.js';

function renderSectionLines(section: ReadinessSection): string[] {
  const lines: string[] = [];
  lines.push(`${section.title}:`);
  for (const check of section.checks) {
    lines.push(`  ${check.severity} ${check.id}: ${sanitizeTerminalDisplayText(check.summary)}`);
    for (const detail of check.details ?? []) {
      lines.push(`    ${sanitizeTerminalDisplayText(detail)}`);
    }
    if (check.fix) {
      lines.push(`    Fix: ${sanitizeTerminalDisplayText(check.fix)}`);
    }
  }
  return lines;
}

function formatRequiredAction(nextAction: ReadinessReport['nextAction']): string {
  const label = sanitizeTerminalDisplayText(nextAction.label);
  const command = nextAction.command ? ` (${sanitizeTerminalDisplayText(nextAction.command)})` : '';
  return `Required action: ${label}${command}`;
}

export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(
    `Run readiness: ${report.status} (${report.counts.blocker} blockers, ${report.counts.warning} warnings)`,
  );
  if (report.status === 'blocked') {
    lines.push(formatRequiredAction(report.nextAction));
  } else if (report.counts.warning > 0) {
    lines.push(`Advisory: ${countNoun(report.counts.warning, 'warning')}; start can continue.`);
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
  lines.push(formatRequiredAction(blockerOnly.nextAction));
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
  return blockers
    .map((check) => `${check.id}: ${sanitizeTerminalDisplayText(check.summary)}`)
    .join('\n');
}

export function readinessBlockerPointer(report: ReadinessReport): string {
  return `Run readiness blocked: ${countNoun(report.counts.blocker, 'blocker')}. Resolve the blockers above (run \`diptych doctor\` for details).`;
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

  return StartReadinessRecordSchema.parse({
    type: 'start-readiness',
    generatedAt: report.generatedAt,
    status: report.status,
    nextAction: report.nextAction.kind,
    blockerCount: report.counts.blocker,
    warningCount: report.counts.warning,
    checks,
  });
}
