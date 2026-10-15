import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { countNoun, pluralize } from '../../utils/pluralize.js';
import {
  READINESS_MODEL_SELECTIONS,
  StartReadinessRecordSchema,
  cliExecutableTrustRemediation,
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
  'untrusted-path': cliExecutableTrustRemediation('the configured CLI'),
  'incompatible-version': 'Install the tested CLI version, then run `splitbrief doctor` again.',
  unauthenticated: 'Sign in to the configured CLI, then run `splitbrief doctor` again.',
  'auth-unknown':
    'CLI authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real call settles it; if it fails to authenticate, sign in to the CLI again.',
  'auth-timeout': 'Check the network connection, then run `splitbrief doctor` again.',
  'auth-offline': 'Check the network connection, then run `splitbrief doctor` again.',
  'auth-malformed':
    'Run `splitbrief doctor` again. If the result is still unreadable, update the CLI.',
  'auth-policy-denied': 'Check the account and access policy, then run `splitbrief doctor` again.',
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
  seats?: string[] | undefined;
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
  [/\busage-limit\b/, 'quota-rate-limit'],
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
    ...(check.runnerCause !== undefined && { seats: check.runnerCause.seats }),
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

const READINESS_STATUS_WORDS: Readonly<Record<ReadinessReport['status'], string>> = {
  ready: 'ready',
  'ready-with-warnings': 'ready with warnings',
  blocked: 'blocked',
};

/** `blocker` and `warning`, the longest severity words, so every summary starts in one column. */
const SEVERITY_WIDTH = 7;
const DETAIL_INDENT = ' '.repeat(2 + SEVERITY_WIDTH + 2);

/** The check id is for scripts (`--json`); a person reads the severity and the words. */
function renderSectionLines(section: ReadinessSection): string[] {
  const lines: string[] = [];
  lines.push(`${section.title}:`);
  for (const check of section.checks) {
    lines.push(
      `  ${check.severity.padEnd(SEVERITY_WIDTH)}  ${sanitizeTerminalDisplayText(check.summary)}`,
    );
    for (const detail of check.details ?? []) {
      lines.push(`${DETAIL_INDENT}${sanitizeTerminalDisplayText(detail)}`);
    }
    const remediation = readinessCheckRemediation(check);
    if (remediation) {
      lines.push(`${DETAIL_INDENT}Fix: ${sanitizeTerminalDisplayText(remediation)}`);
    }
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

export function createStartReadinessRecord(report: ReadinessReport): StartReadinessRecord {
  const checks = report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker' || check.severity === 'warning')
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

/** A recorded start warning as the run states it on one line: what readiness found, then what to do. */
export function startReadinessWarnings(record: StartReadinessRecord): string[] {
  return record.checks
    .filter((check) => check.severity === 'warning')
    .map((check) =>
      check.remediation === undefined ? check.summary : `${check.summary} ${check.remediation}`,
    );
}
