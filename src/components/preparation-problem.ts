import type { NoticeMessage } from './notice.js';
import { readinessCheckRemediation } from '../core/readiness/json.js';
import type { ReadinessReport, ReadinessCheck } from '../core/readiness/types.js';
import { sessionPreparationError } from '../core/sessions/errors.js';
import { SOFT_SEP } from '../core/separators.js';
import { glyph } from '../lib/glyphs.js';
import type { PreparationViewState } from '../stores/navigation/preparation.js';
import { sanitizeTerminalDiagnosticText } from '../utils/display-text/diagnostic.js';
import { sanitizeTerminalDisplayText } from '../utils/display-text/sanitize.js';
import { getTerminalCellWidth } from '../utils/display-text/width.js';

function checksOf(report: ReadinessReport | undefined, severity: ReadinessCheck['severity']) {
  if (!report) return [];
  return report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === severity);
}

export interface PreparationProblem {
  failed: boolean;
  cause: string;
  action?: string | undefined;
  primaryFix?: string | undefined;
  reason?: string | undefined;
  diagnostic?: string | undefined;
  settings: boolean;
  blockers: readonly ReadinessCheck[];
  warnings: readonly ReadinessCheck[];
  details: readonly string[];
}

/**
 * The cause leads, and it is never a count: a failure with no blocker at all still has to say what
 * went wrong. A blocked check leads with the first blocker it found and that blocker's own fix; a
 * failed one leads with the error it raised.
 */
export function panelModel(state: PreparationViewState): PreparationProblem | null {
  if (state.kind !== 'blocked' && state.kind !== 'failed') return null;
  const blockers = checksOf(state.report, 'blocker');
  const warnings = checksOf(state.report, 'warning');
  const settings = blockers.some((check) => check.nextAction === 'fix-config');
  if (state.kind === 'failed') {
    const failure = state.error;
    const session = sessionPreparationError.isIo(failure) ? failure.data : undefined;
    const cause = sanitizeTerminalDiagnosticText(session?.title ?? failure.message).trim();
    return {
      failed: true,
      settings,
      cause: cause || 'Tool preparation failed.',
      reason: session?.reason,
      action:
        session?.operation === 'allocate-session'
          ? 'Check the folder and its write permissions.'
          : blockers[0] &&
            sanitizeTerminalDisplayText(readinessCheckRemediation(blockers[0]) ?? ''),
      diagnostic:
        failure.cause instanceof Error
          ? sanitizeTerminalDiagnosticText(failure.cause.message)
          : undefined,
      blockers,
      warnings,
      details: [],
    };
  }
  const [lead, ...rest] = blockers;
  return {
    failed: false,
    settings,
    cause:
      lead === undefined
        ? sanitizeTerminalDisplayText(state.report.nextAction.reason)
        : sanitizeTerminalDisplayText(lead.summary),
    action: lead && sanitizeTerminalDisplayText(readinessCheckRemediation(lead) ?? ''),
    primaryFix: lead?.primaryFix && sanitizeTerminalDisplayText(lead.primaryFix),
    blockers: rest,
    warnings,
    details: lead?.details ?? [],
  };
}

export function preparationNotice(model: PreparationProblem): NoticeMessage {
  const cause = [model.cause, model.reason].filter(Boolean).join(': ');
  return {
    severity: model.failed ? 'error' : 'warning',
    message: [cause, model.primaryFix ?? model.action]
      .filter(Boolean)
      .join(` ${glyph('connectorHandoff')} `),
  };
}

export function preparationHint(model: PreparationProblem, width: number, home = false): string {
  return fitHint(
    [
      home ? 'enter retry' : 'r retry',
      'ctrl+d details',
      ...(model.settings ? [home ? '/settings' : 's settings'] : []),
      'esc dismiss',
    ],
    width,
  );
}

/** The keys shed from the tail, so the repair actions survive the narrowest panel. */
export function fitHint(segments: readonly string[], budget: number): string {
  const kept = [...segments];
  while (kept.length > 1 && getTerminalCellWidth(kept.join(SOFT_SEP)) > budget) kept.pop();
  return kept.join(SOFT_SEP);
}
