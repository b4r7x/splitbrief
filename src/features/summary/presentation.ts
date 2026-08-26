import type { Summary } from '../../core/schemas/summary.js';
import type { Session } from '../../core/schemas/session.js';
import type { Theme } from '../../components/theme.js';
import type { GlyphName } from '../../lib/glyphs.js';
import { arrowSep } from '../../components/separators.js';
import { formatToolModel } from '../../core/model-display.js';
import { uniqueSorted } from '../../utils/collections.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { countNoun } from '../../utils/pluralize.js';
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

export function getSummaryHeading(status: Session['status'], theme: Theme): SummaryHeading {
  switch (status) {
    case 'complete':
      return { word: 'complete', color: theme.success, glyph: 'check' };
    case 'failed':
      return { word: 'failed', color: theme.error, glyph: 'statusFailed' };
    case 'interrupted':
      return { word: 'interrupted', color: theme.warning, glyph: 'statusCancelled' };
    default:
      return assertNever(status);
  }
}

export function formatPlannerSummary(summary: Summary): string | null {
  if (!summary.plannerTool) return null;
  return stripTerminalControls(formatToolModel(summary.plannerTool, summary.plannerModel));
}

export function formatRouteSummary(
  summary: Summary,
  implementerSummary: string | null,
): string | null {
  const plannerSummary = formatPlannerSummary(summary);
  if (!plannerSummary && !implementerSummary) return null;
  if (!plannerSummary) return implementerSummary;
  if (!implementerSummary) return plannerSummary;
  return `${plannerSummary}${arrowSep()}${implementerSummary}`;
}

export function compactCount(count: number, noun: string): string {
  return countNoun(count, noun);
}

export function compactPacketPath(path: string): string {
  const clean = stripTerminalControls(path);
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}
