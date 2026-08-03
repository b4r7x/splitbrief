import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { countNoun } from '../../utils/pluralize.js';
import {
  READINESS_MODEL_SELECTIONS,
  StartReadinessRecordSchema,
  type ReadinessDiagnosticStateId,
  type ReadinessModelSelection,
  type StartReadinessRecord,
} from '../schemas/readiness.js';
import { ungatedCliReadinessChecks } from './status.js';
import type { ReadinessCheck, ReadinessReport, ReadinessSection } from './types.js';

export const READINESS_DIAGNOSTIC_REMEDIATION: Readonly<
  Record<ReadinessDiagnosticStateId, string>
> = {
  'missing-binary': 'Install the configured CLI, then run `splitbrief doctor` again.',
  'untrusted-path': 'Trust the exact CLI executable identity, then run `splitbrief doctor` again.',
  'incompatible-version': 'Install the tested CLI version, then run `splitbrief doctor` again.',
  unauthenticated:
    'Authenticate the CLI in the staged runner environment, then run `splitbrief doctor` again.',
  'auth-unknown':
    'Verify CLI authentication in the staged runner environment, then run `splitbrief doctor` again.',
  'endpoint-invalid':
    'Fix the provider endpoint to match its declared policy, then run `splitbrief doctor` again.',
  'credential-family-mismatch':
    'Use a credential that matches the declared provider family, then run `splitbrief doctor` again.',
  'protocol-failure':
    'Check the CLI or provider version and output protocol, then run `splitbrief doctor` again.',
  'quota-rate-limit':
    'Wait for quota or rate limits to reset, reduce request volume, or switch providers, then run `splitbrief doctor` again.',
  'conflicting-args':
    'Remove conflicting runner arguments from the config, then run `splitbrief doctor` again.',
};

export interface ReadinessDiagnosticCheckJson {
  id: string;
  severity: ReadinessCheck['severity'];
  summary: string;
  stateId: ReadinessDiagnosticStateId | null;
  remediation: string | null;
  details?: string[] | undefined;
  nextAction?: ReadinessCheck['nextAction'];
  modelSelection?: ReadinessModelSelection | undefined;
}

export interface ReadinessReportJson {
  generatedAt: string;
  projectDir: string;
  status: ReadinessReport['status'];
  counts: ReadinessReport['counts'];
  nextAction: ReadinessReport['nextAction'];
  checks: ReadinessDiagnosticCheckJson[];
  metadata: ReadinessReport['metadata'];
}

/**
 * Last resort for failure families a check can only observe as quoted error
 * text — a nested runner or provider failure repeated inside a detail line.
 * Every pattern matches a SPLITBRIEF error kind, runner outcome state, or HTTP
 * status code, never English prose, so rewording a message can never change a
 * published `stateId`. Producers that know the family set `diagnosticState`.
 */
const DIAGNOSTIC_TEXT_STATES: readonly (readonly [RegExp, ReadinessDiagnosticStateId])[] = [
  [/\bprovider-endpoint-invalid\b|\bapi-base-[a-z-]+\b/, 'endpoint-invalid'],
  [/\bprovider-credential-prefix-mismatch\b/, 'credential-family-mismatch'],
  [/\bprotocol-failure\b/, 'protocol-failure'],
  [/\b429\b/, 'quota-rate-limit'],
  [/\bconflicting-args\b/, 'conflicting-args'],
  [/\bspawn-not-found\b/, 'missing-binary'],
  [/\bincompatible-version\b/, 'incompatible-version'],
  [/\bunauthenticated\b/, 'unauthenticated'],
];

function errorTextStateId(check: ReadinessCheck): ReadinessDiagnosticStateId | null {
  const text = [check.summary, check.fix, ...(check.details ?? [])].filter(Boolean).join('\n');
  const matched = DIAGNOSTIC_TEXT_STATES.find(([pattern]) => pattern.test(text));
  return matched ? matched[1] : null;
}

export function deriveReadinessDiagnosticState(
  check: ReadinessCheck,
): ReadinessDiagnosticStateId | null {
  return check.diagnosticState ?? errorTextStateId(check);
}

export function readinessCheckRemediation(check: ReadinessCheck): string | null {
  if (check.fix) return check.fix;
  const stateId = deriveReadinessDiagnosticState(check);
  return stateId === null ? null : READINESS_DIAGNOSTIC_REMEDIATION[stateId];
}

/**
 * Metadata is a free-form bag that may hold identity-bearing values, so the JSON
 * surface publishes named fields only. `modelSelection` is published because a
 * consumer cannot otherwise tell automatic selection from an unset model — both
 * serialize their resolved model as absent.
 */
function checkModelSelection(check: ReadinessCheck): ReadinessModelSelection | undefined {
  const value = check.metadata?.modelSelection;
  return READINESS_MODEL_SELECTIONS.find((candidate) => candidate === value);
}

export function serializeReadinessCheckJson(check: ReadinessCheck): ReadinessDiagnosticCheckJson {
  const stateId = deriveReadinessDiagnosticState(check);
  const remediation = readinessCheckRemediation(check);
  const modelSelection = checkModelSelection(check);
  return {
    id: check.id,
    severity: check.severity,
    summary: check.summary,
    stateId,
    remediation,
    ...(check.details !== undefined && { details: check.details }),
    ...(check.nextAction !== undefined && { nextAction: check.nextAction }),
    ...(modelSelection !== undefined && { modelSelection }),
  };
}

export function serializeReadinessReportJson(report: ReadinessReport): ReadinessReportJson {
  return {
    generatedAt: report.generatedAt,
    projectDir: report.projectDir,
    status: report.status,
    counts: report.counts,
    nextAction: report.nextAction,
    checks: report.sections.flatMap((section) =>
      section.checks.map((check) => serializeReadinessCheckJson(check)),
    ),
    metadata: report.metadata,
  };
}

function renderSectionLines(section: ReadinessSection): string[] {
  const lines: string[] = [];
  lines.push(`${section.title}:`);
  for (const check of section.checks) {
    lines.push(`  ${check.severity} ${check.id}: ${sanitizeTerminalDisplayText(check.summary)}`);
    for (const detail of check.details ?? []) {
      lines.push(`    ${sanitizeTerminalDisplayText(detail)}`);
    }
    const remediation = readinessCheckRemediation(check);
    if (remediation) {
      lines.push(`    Fix: ${sanitizeTerminalDisplayText(remediation)}`);
    }
  }
  return lines;
}

function formatRequiredAction(nextAction: ReadinessReport['nextAction']): string {
  const label = sanitizeTerminalDisplayText(nextAction.label);
  const command = nextAction.command ? ` (${sanitizeTerminalDisplayText(nextAction.command)})` : '';
  return `Required action: ${label}${command}`;
}

/**
 * A CLI runner without a trusted readiness identity gets no start gate, so the
 * one thing the reader must not be told is that start can continue.
 */
function ungatedCliStartPointer(checks: readonly ReadinessCheck[]): string {
  const tools = checks
    .map((check) => sanitizeTerminalDisplayText(String(check.metadata?.tool ?? check.id)))
    .join(', ');
  return `Start blocked: no trusted readiness identity for ${tools}.`;
}

export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(
    `Run readiness: ${report.status} (${report.counts.blocker} blockers, ${report.counts.warning} warnings)`,
  );
  const ungatedCli = ungatedCliReadinessChecks(report);
  if (report.status === 'blocked') {
    lines.push(formatRequiredAction(report.nextAction));
  } else if (ungatedCli.length > 0) {
    lines.push(`${ungatedCliStartPointer(ungatedCli)} Fix it below, then start again.`);
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
  return `Run readiness blocked: ${countNoun(report.counts.blocker, 'blocker')}. Resolve the blockers above (run \`splitbrief doctor\` for details).`;
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
