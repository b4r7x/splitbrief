import { sanitizeTerminalDisplayText } from '../../utils/display-text/sanitize.js';
import { countNoun, pluralize } from '../../utils/pluralize.js';
import { StartReadinessRecordSchema, type StartReadinessRecord } from '../schemas/readiness.js';
import { ungatedCliReadinessChecks } from './status.js';
import type { ReadinessCheck, ReadinessReport, ReadinessSection } from './types.js';
import type { SessionRef } from '../types/session-ref.js';
import { CONFIG_WARNING_CHECK_ID } from './checks/config.js';
import { withRunFolder } from './checks/repo.js';
import { isSettingNotAppliedCheck } from './checks/runner/fields.js';
import { readinessCheckRemediation } from './json.js';

const READINESS_STATUS_WORDS: Readonly<Record<ReadinessReport['status'], string>> = {
  ready: 'ready',
  'ready-with-warnings': 'ready with warnings',
  blocked: 'blocked',
};

/** `blocker` and `warning`, the longest severity words, so every summary starts in one column. */
const SEVERITY_WIDTH = 7;
const DETAIL_INDENT = ' '.repeat(2 + SEVERITY_WIDTH + 2);

/** A check as every surface states it: the summary, each detail, then the fix. */
export function readinessCheckLines(
  check: Readonly<{
    summary: string;
    details?: readonly string[] | undefined;
    remediation?: string | null | undefined;
  }>,
): string[] {
  return [
    check.summary,
    ...(check.details ?? []),
    ...(check.remediation ? [`Fix: ${check.remediation}`] : []),
  ];
}

/** The check id is for scripts (`--json`); a person reads the severity and the words. */
function renderSectionLines(section: ReadinessSection): string[] {
  const lines: string[] = [];
  lines.push(`${section.title}:`);
  for (const check of section.checks) {
    const [summary, ...rest] = readinessCheckLines({
      ...check,
      remediation: readinessCheckRemediation(check),
    }).map((line) => sanitizeTerminalDisplayText(line));
    lines.push(`  ${check.severity.padEnd(SEVERITY_WIDTH)}  ${summary}`);
    lines.push(...rest.map((line) => `${DETAIL_INDENT}${line}`));
  }
  return lines;
}

/**
 * Ungated CLI readiness is a warning, not a blocker: interactive start may
 * proceed after disclosure, but headless admission stays fail-closed.
 */
function ungatedCliAdvisory(checks: readonly ReadinessCheck[]): string {
  const tools = checks
    .map((check) => sanitizeTerminalDisplayText(String(check.metadata?.tool ?? check.id)))
    .join(', ');
  return `No trusted readiness identity for ${tools}: headless start would be refused; use --allow-unverified-auth or complete verification — interactive start proceeds.`;
}

export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(
    `Run readiness: ${READINESS_STATUS_WORDS[report.status]} (${countNoun(report.counts.blocker, 'blocker')}, ${countNoun(report.counts.warning, 'warning')})`,
  );
  // Each blocker carries its own Fix line, so the header names no action that would repeat it.
  const ungatedCli = ungatedCliReadinessChecks(report);
  if (report.status !== 'blocked' && ungatedCli.length > 0) {
    lines.push(ungatedCliAdvisory(ungatedCli));
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
  lines.push(`Run readiness: blocked (${countNoun(blockerOnly.counts.blocker, 'blocker')})`);
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
  return blockers.map((check) => sanitizeTerminalDisplayText(check.summary)).join('\n');
}

export function readinessBlockerPointer(report: ReadinessReport): string {
  return `Run readiness blocked: ${countNoun(report.counts.blocker, 'blocker')}. Resolve the ${pluralize(report.counts.blocker, 'blocker')} above (run \`splitbrief doctor\` for details).`;
}

function blockerOnlySection(section: ReadinessSection): ReadinessSection | null {
  const checks = section.checks.filter((check) => check.severity === 'blocker');
  if (checks.length === 0) return null;
  return { ...section, checks };
}

/** The run's own record of its admission, so a check that names the run's folder names it. */
export function createStartReadinessRecord(
  report: ReadinessReport,
  run: SessionRef,
): StartReadinessRecord {
  const checks = report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker' || check.severity === 'warning')
    .map((check) => withRunFolder(check, run))
    .map((check) => {
      const remediation = readinessCheckRemediation(check);
      return {
        id: check.id,
        severity: check.severity,
        summary: check.summary,
        ...(check.details !== undefined && check.details.length > 0 && { details: check.details }),
        ...(remediation !== null && { remediation }),
      };
    });

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

/**
 * The warnings that name a flag or a setting SPLITBRIEF does not apply, each as its lines. A `seat`
 * keeps the settings of that seat only; a flag or a config notice holds for every seat.
 */
export function notAppliedWarnings(
  report: ReadinessReport,
  seat?: 'planner' | 'reviewer' | undefined,
): string[][] {
  return report.sections
    .flatMap((section) => section.checks)
    .filter(
      (check) =>
        check.severity === 'warning' &&
        (check.id === CONFIG_WARNING_CHECK_ID || isSettingNotAppliedCheck(check, seat)),
    )
    .map((check) =>
      readinessCheckLines({ ...check, remediation: readinessCheckRemediation(check) }),
    );
}

/** A recorded start warning as the run states it: what readiness found, its details, then what to do. */
export function startReadinessWarnings(record: StartReadinessRecord): string[] {
  return record.checks
    .filter((check) => check.severity === 'warning')
    .map((check) => readinessCheckLines(check).join('\n'));
}
