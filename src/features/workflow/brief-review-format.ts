import type {
  BriefRecoveryProjectionV1,
  RecoveryBlocker,
} from '../../core/schemas/brief-recovery.js';
import type { BriefQualityReport } from '../../engine/spec/brief-quality.js';
import type { BriefReadinessGateReport } from '../../engine/orchestrator/planning/brief-readiness-gate.js';
import {
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { countNoun } from '../../utils/pluralize.js';

export type BriefReviewFormatInput = Readonly<{
  projection: BriefRecoveryProjectionV1;
  quality?: BriefQualityReport | null | undefined;
  readiness?: BriefReadinessGateReport | null | undefined;
  taskCount?: number | undefined;
  width?: number | undefined;
}>;

export type EvidenceSpineLines = Readonly<{
  status: string;
  evidence: string;
  cause: string;
  consequence: string;
  action: string;
  supplemental: string;
}>;

export function formatQualityDisplay(quality: BriefQualityReport | null): string {
  if (quality === null) return 'quality n/a';
  return `quality ${quality.score.toFixed(2)}`;
}

export function formatTaskCount(count: number): string {
  return countNoun(count, 'task');
}

export function sanitizeTaskDisplayText(text: string): string {
  return sanitizeTerminalDisplayText(text);
}

export function truncateBriefDisplayText(text: string, maxCells: number): string {
  return truncateTerminalDisplayText(sanitizeTerminalDisplayText(text), maxCells);
}

export function formatBriefRecoveryStatus(
  projection: BriefRecoveryProjectionV1,
  readiness: BriefReadinessGateReport | null = null,
): string {
  if (projection.status === 'ready' && readiness !== null && !readiness.ok) {
    return 'READINESS BLOCKED';
  }
  switch (projection.status) {
    case 'checking':
      return 'CHECKING CONTRACT';
    case 'auto-repairing':
      return 'AUTO-REPAIRING';
    case 'blocked':
    case 'storage-blocked':
      return 'CONTRACT BLOCKED';
    case 'readiness-blocked':
      return 'READINESS BLOCKED';
    case 'retrying':
      return 'RETRYING';
    case 'unresolved':
      return 'RETRY UNRESOLVED';
    case 'ready':
      return 'CONTRACT READY';
    case 'rejected':
      return 'CONTRACT BLOCKED';
    default: {
      const exhaustive: never = projection.status;
      return exhaustive;
    }
  }
}

export function formatBriefEvidenceMeta(projection: BriefRecoveryProjectionV1): string {
  const briefRevision = projection.activeBrief?.revision;
  const reportRevision = projection.matchingReport?.report.revision;
  return `BRIEF r${briefRevision ?? '—'} | CHECK r${reportRevision ?? '—'}`;
}

function sanitizedCauseText(text: string): string {
  const clean = sanitizeTerminalDisplayText(text).replace(/\s+/g, ' ').trim();
  return clean === '' ? 'unavailable' : clean;
}

function issueCause(projection: BriefRecoveryProjectionV1): string | null {
  const issue = projection.matchingReport?.issues.find(
    (candidate) => candidate.severity === 'error',
  );
  if (issue === undefined) return null;
  const scope = issue.taskId === null ? 'GENERAL' : issue.taskId;
  return `QUALITY ISSUE ${scope}: ${sanitizedCauseText(issue.message)}`;
}

function blockerCause(blocker: RecoveryBlocker): string {
  switch (blocker.kind) {
    case 'quality': {
      const issue = blocker.issues[0];
      if (issue === undefined) return 'QUALITY ISSUE: unavailable';
      const scope = issue.taskId === null ? 'GENERAL' : issue.taskId;
      return `QUALITY ISSUE ${scope}: ${sanitizedCauseText(issue.message)}`;
    }
    case 'provider':
      return `PROVIDER REFUSAL ${sanitizeTerminalDisplayText(blocker.code)}: ${sanitizedCauseText(blocker.message)}`;
    case 'budget':
      return `BUDGET REFUSAL ${sanitizeTerminalDisplayText(blocker.code)}`;
    case 'no-progress':
      return `RETRY REFUSAL ${sanitizeTerminalDisplayText(blocker.code)} (${blocker.count})`;
    case 'storage':
      return `STORAGE: ${sanitizedCauseText(blocker.message)}`;
    case 'unresolved':
      return `UNRESOLVED RETRY ${sanitizeTerminalDisplayText(blocker.operationId)}`;
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}

export function formatBriefRecoveryCause(
  projection: BriefRecoveryProjectionV1,
  readiness: BriefReadinessGateReport | null = null,
): string {
  if (projection.status === 'storage-blocked') return 'BECAUSE STORAGE';
  if (
    (projection.status === 'ready' || projection.status === 'readiness-blocked') &&
    readiness !== null &&
    !readiness.ok
  ) {
    return 'BECAUSE READINESS CHECKS';
  }
  if (projection.status === 'readiness-blocked') return 'BECAUSE READINESS CHECKS';
  const cause =
    issueCause(projection) ??
    (projection.blocker === null ? null : blockerCause(projection.blocker));
  if (cause === null) {
    if (projection.status === 'ready') return 'BECAUSE CONTRACT CHECK PASSED';
    if (projection.status === 'checking') return 'BECAUSE CONTRACT CHECK IS IN PROGRESS';
    return 'BECAUSE THE CURRENT RECOVERY CAUSE IS UNAVAILABLE';
  }
  return `BECAUSE ${cause}`;
}

export function formatBriefRecoveryConsequence(
  projection: BriefRecoveryProjectionV1,
  readiness: BriefReadinessGateReport | null = null,
): string {
  if (projection.status === 'ready' && readiness !== null && !readiness.ok) {
    return 'SO approval is blocked by readiness checks';
  }
  switch (projection.status) {
    case 'checking':
    case 'auto-repairing':
      return 'SO the Brief is not yet available for approval';
    case 'blocked':
      return 'SO approval and implementation are unavailable until errors are cleared';
    case 'storage-blocked':
      return 'SO the saved Brief cannot be trusted until storage is repaired';
    case 'retrying':
      return 'SO the current retry is in flight and duplicate retry is unavailable';
    case 'unresolved':
      return 'SO remote execution is unknown and another retry is unavailable';
    case 'ready':
      return 'SO the current zero-error Brief may proceed to approval';
    case 'readiness-blocked':
      return 'SO approval is blocked by operational readiness checks';
    case 'rejected':
      return 'SO this Brief epoch is closed';
    default: {
      const exhaustive: never = projection.status;
      return exhaustive;
    }
  }
}

export function formatBriefRecoveryAction(
  projection: BriefRecoveryProjectionV1,
  readiness: BriefReadinessGateReport | null = null,
): string {
  if (projection.status === 'ready' && readiness !== null && !readiness.ok) {
    return 'NOW edit or reject';
  }
  switch (projection.status) {
    case 'checking':
    case 'auto-repairing':
    case 'retrying':
      return 'NOW wait for the current contract operation';
    case 'blocked':
      return 'NOW retry, edit, or reject';
    case 'storage-blocked':
      return 'NOW import, edit, or reject';
    case 'unresolved':
      return 'NOW resolve-unresolved, edit, or reject';
    case 'ready':
      return 'NOW approve or edit';
    case 'readiness-blocked':
      return 'NOW edit or reject';
    case 'rejected':
      return 'NOW start a new Brief epoch';
    default: {
      const exhaustive: never = projection.status;
      return exhaustive;
    }
  }
}

export function formatBriefRecoveryCounts(projection: BriefRecoveryProjectionV1): string {
  const { count, carriedCount, heldCount, releasedCount } = projection.queuedInputs;
  const queuedCount = Math.max(0, count - carriedCount - heldCount - releasedCount);
  const parts: string[] = [];
  if (queuedCount > 0) parts.push(`QUEUED ${queuedCount}`);
  if (carriedCount > 0) parts.push(`CARRIED ${carriedCount}`);
  if (heldCount > 0) parts.push(`HELD ${heldCount}`);
  return parts.join(' | ');
}

function supplementalText(
  projection: BriefRecoveryProjectionV1,
  quality: BriefQualityReport | null | undefined,
  taskCount: number | undefined,
): string {
  const issues = projection.matchingReport?.issues ?? [];
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const score =
    quality === undefined || quality === null ? '' : ` | ${formatQualityDisplay(quality)}`;
  const tasks = taskCount === undefined ? '' : ` | ${formatTaskCount(taskCount)}`;
  return `ISSUES ${errors} | WARNINGS ${warnings}${tasks}${score}`;
}

export function formatEvidenceSpine(input: BriefReviewFormatInput): EvidenceSpineLines {
  const { projection, quality, readiness = null, taskCount } = input;
  const counts = formatBriefRecoveryCounts(projection);
  return {
    status: formatBriefRecoveryStatus(projection, readiness),
    evidence: formatBriefEvidenceMeta(projection),
    cause: formatBriefRecoveryCause(projection, readiness),
    consequence: formatBriefRecoveryConsequence(projection, readiness),
    action: formatBriefRecoveryAction(projection, readiness),
    supplemental: `${counts}${counts === '' ? '' : ' | '}${supplementalText(
      projection,
      quality,
      taskCount,
    )}`,
  };
}

export function formatEvidenceSpineLines(
  input: BriefReviewFormatInput,
  maxCells = Number.POSITIVE_INFINITY,
): string[] {
  const lines = formatEvidenceSpine(input);
  const cellLimit = input.width ?? maxCells;
  return [
    lines.status,
    lines.evidence,
    lines.cause,
    lines.consequence,
    lines.action,
    lines.supplemental,
  ].map((line) =>
    Number.isFinite(cellLimit)
      ? truncateBriefDisplayText(line, cellLimit)
      : sanitizeTerminalDisplayText(line),
  );
}
