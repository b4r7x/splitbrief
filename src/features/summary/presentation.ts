import type { Summary } from '../../core/schemas/summary.js';
import type { Session } from '../../core/schemas/session.js';
import type { Theme } from '../../components/theme.js';
import type { GlyphName } from '../../lib/glyphs.js';
import { arrowSep, SOFT_SEP } from '../../components/separators.js';
import { formatToolModel } from '../../core/model-display.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { uniqueSorted } from '../../utils/collections.js';
import { countNoun } from '../../utils/pluralize.js';
import { getTerminalCellWidth, stripTerminalControls } from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';

export function formatImplementerSummary(summary: Summary): string | null {
  if (!summary.implementerTool) return null;

  const taskImplementers = summary.taskBreakdown
    ?.filter(
      (task) =>
        task.tool !== undefined ||
        task.model !== undefined ||
        task.implementerProfile !== undefined,
    )
    .map(
      (task) => `${task.implementerProfile ?? ''}\u0000${task.tool ?? ''}\u0000${task.model ?? ''}`,
    );

  const uniqueTaskImplementers = new Set(taskImplementers ?? []);
  if (uniqueTaskImplementers.size > 1) {
    const profiles = uniqueSorted(
      summary.taskBreakdown
        ?.map((task) => task.implementerProfile)
        .filter((profile): profile is string => profile !== undefined) ?? [],
    );
    return profiles.length > 0
      ? stripTerminalControls(`mixed profiles (${profiles.join(', ')})`)
      : 'mixed implementers';
  }

  return stripTerminalControls(formatToolModel(summary.implementerTool, summary.implementerModel));
}

export interface SummaryHeading {
  word: string;
  color: string;
  glyph: GlyphName;
}

/**
 * The heading states how the run ended. A run that reached the end with findings still open is not
 * a green tick: the eye takes the heading first, so it carries the outcome's tone, not just the
 * session's exit status.
 */
export function getSummaryHeading(
  status: Session['status'],
  theme: Theme,
  ready: boolean,
): SummaryHeading {
  switch (status) {
    case 'complete':
      return ready
        ? { word: 'complete', color: theme.success, glyph: 'check' }
        : { word: 'complete', color: theme.warning, glyph: 'statusWarning' };
    case 'failed':
      return { word: 'failed', color: theme.error, glyph: 'statusFailed' };
    case 'interrupted':
      return { word: 'interrupted', color: theme.warning, glyph: 'statusCancelled' };
    case 'cancelled':
      return { word: 'cancelled', color: theme.warning, glyph: 'statusCancelled' };
    default:
      return assertNever(status);
  }
}

export interface SummaryOutcome {
  /** `Build finished · ready` or `Build finished · changes need attention`. */
  headline: string;
  ready: boolean;
  /** The three facts under it, in reading order. */
  facts: readonly string[];
  /** What is left to read; empty when nothing blocks and on a short terminal. */
  next: string;
}

function reviewCounts(summary: Summary): string {
  const review = summary.review;
  if (review === undefined) return 'review: not run';
  const counts = `${review.critical} blocking, ${review.warnings} advisory`;
  const verdict = summary.reviewPacket?.finalReviewVerdict ?? review.verdict;
  return verdict === 'fail' ? `review failed · ${counts}` : `review: ${counts}`;
}

function checksText(summary: Summary, passed: number): string {
  const checks =
    summary.totalTasks === 0
      ? 'No briefs ran'
      : `${passed}/${summary.totalTasks} briefs passed checks`;
  return `${checks}${SOFT_SEP}${reviewCounts(summary)}`;
}

function scopeText(summary: Summary): string {
  const drift = summary.driftSummary;
  if (drift === undefined) return 'Scope check: not run';
  const deviations = drift.errorCount + drift.warningCount;
  return `Scope check: ${deviations === 0 ? 'no deviations' : `${deviations} deviations`}`;
}

function changedFilesText(summary: Summary): string {
  const changed = summary.changedFiles;
  if (changed === undefined) return 'files changed: unavailable';
  return `${countNoun(changed.length, 'file')} changed`;
}

// The screen's own ⏎ goes home (`Press enter to continue` in the footer), so the row names the
// artifact to read instead of promising a key that does something else. A run with nothing blocking
// has nothing to act on here — the packet's own rows below already carry its paths.
function nextText(summary: Summary): string {
  const path = summary.reviewPacket?.markdownPath;
  const blocking = summary.review?.critical ?? 0;
  if (path === undefined || blocking === 0) return '';
  return `${countNoun(blocking, 'blocking finding')} in ${path}`;
}

/**
 * What the run left behind, in the order a reader asks it: is it ready, did the checks and the
 * review agree, did it stay in scope, what did it touch, and what is left to read.
 */
export function summarizeOutcome(
  summary: Summary,
  status: Session['status'],
  options: { compact?: boolean; width?: number } = {},
): SummaryOutcome {
  const verdict = summary.reviewPacket?.finalReviewVerdict ?? summary.review?.verdict ?? null;
  const reviewWritten = summary.reviewPacket?.finalReviewStatus === 'written';
  const ready =
    status === 'complete' &&
    reviewWritten &&
    (verdict === 'pass' || verdict === 'pass_with_notes') &&
    summary.reviewPacket?.driftPassed === true &&
    summary.failed === 0;
  const passed = summary.completedByLocal + summary.escalatedToPlanner;
  const checks = checksText(summary, passed);
  const scopeAndFiles = [scopeText(summary), changedFilesText(summary)];
  const oneLine = [checks, ...scopeAndFiles].join(SOFT_SEP);
  // A short terminal spends its rows on the details below, so the facts ride one line there — but
  // only while that line fits. Folding them onto a line too narrow for it costs more than the row
  // it saves: the facts at the end of it leave the screen.
  const ridesOneLine =
    options.compact === true &&
    (options.width === undefined || getTerminalCellWidth(oneLine) <= options.width);
  return {
    headline: `Build finished${SOFT_SEP}${ready ? 'ready' : 'changes need attention'}`,
    ready,
    facts: ridesOneLine
      ? [oneLine]
      : options.compact === true
        ? [checks, scopeAndFiles.join(SOFT_SEP)]
        : [checks, ...scopeAndFiles],
    next: options.compact === true ? '' : nextText(summary),
  };
}

export function formatPlannerSummary(summary: Summary): string | null {
  if (!summary.plannerTool) return null;
  return stripTerminalControls(formatToolModel(summary.plannerTool, summary.plannerModel));
}

export function formatReviewerSummary(summary: Summary): string | null {
  if (summary.reviewerTool) {
    return stripTerminalControls(formatToolModel(summary.reviewerTool, summary.reviewerModel));
  }
  return summary.plannerTool ? PLANNER_INHERITANCE.sentence : null;
}

export function formatRouteSummary(
  summary: Summary,
  implementerSummary: string | null,
): string | null {
  const plannerSummary = formatPlannerSummary(summary);
  if (!plannerSummary && !implementerSummary) return null;
  const reviewer = summary.reviewerTool ? formatReviewerSummary(summary) : null;
  const chain = [plannerSummary, implementerSummary, reviewer].filter(
    (part): part is string => part !== null,
  );
  return chain.length === 0 ? null : chain.join(arrowSep());
}

export function compactPacketPath(path: string): string {
  const clean = stripTerminalControls(path);
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}
