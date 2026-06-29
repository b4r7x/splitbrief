import type { Summary } from '../../core/schemas/summary.js';
import type { Session } from '../../core/schemas/session.js';
import type { Theme } from '../../components/theme.js';
import { ARROW_SEP } from '../../components/separators.js';
import { formatToolModel } from '../../core/model-display.js';
import { uniqueSorted } from '../../utils/collections.js';
import { stripTerminalControls } from '../../utils/display-text.js';
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
  marker: boolean;
}

export function getSummaryHeading(status: Session['status'], theme: Theme): SummaryHeading {
  switch (status) {
    case 'complete':
      return { word: 'complete', color: theme.success, marker: true };
    case 'failed':
      return { word: 'failed', color: theme.error, marker: false };
    case 'interrupted':
      return { word: 'interrupted', color: theme.warning, marker: false };
    default:
      return assertNever(status);
  }
}

export function formatRouteSummary(
  summary: Summary,
  implementerSummary: string | null,
): string | null {
  const plannerSummary = summary.plannerTool
    ? stripTerminalControls(formatToolModel(summary.plannerTool, summary.plannerModel))
    : null;
  if (!plannerSummary && !implementerSummary) return null;
  if (!plannerSummary) return implementerSummary;
  if (!implementerSummary) return plannerSummary;
  return `${plannerSummary}${ARROW_SEP}${implementerSummary}`;
}

export function compactCount(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

export function compactPacketPath(path: string): string {
  const clean = stripTerminalControls(path);
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}
