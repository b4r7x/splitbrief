import type { EngineEventOf } from '../../../engine/events/types.js';
import { countNoun } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ActivityDisplayValueFit } from '../display/activity-display-text.js';
import { formatRecordedSeatIdentity } from '../display/recorded-seat-identity.js';
import {
  runnerActivityLedgerItem,
  runnerActivityModelRole,
  runnerActivityRoleLabel,
  type RunnerActivityLedgerItem,
  type RunnerActivityLedgerLabel,
  type RunnerActivitySeverity,
  type RunnerActivityDisplayInput,
} from '../display/runner-activity-display.js';
import type { ConversationRowTone } from './types.js';

export const COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT = 3;

export type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;
type VisibleRunnerActivityEvent = RunnerActivityEvent & {
  kind: RunnerActivityDisplayInput['kind'];
};

export interface ActivityDisplayItem {
  key: string;
  label: RunnerActivityLedgerLabel;
  value: string;
  labelTone: ConversationRowTone;
  valueTone: ConversationRowTone;
  fitMode: ActivityDisplayValueFit;
  severity: RunnerActivitySeverity;
  rawMarker: string | null;
  groupLabel: string;
}

export interface ActivityBatchViewModel {
  batchKey: string;
  visibleItems: readonly ActivityDisplayItem[];
  expanded: boolean;
  hiddenCount: number;
  headerCount: number;
  headerText: string | null;
  /** The tool and model the batch's call ran on; the header row fits it after `headerText`. */
  headerRunner: string | null;
  tone: ConversationRowTone;
  renderableUnits: number;
  expandableKey: string | null;
  severityCounts: Readonly<Record<RunnerActivitySeverity, number>>;
  groups: readonly ActivityBatchGroup[];
  rawMarkers: number;
}

export interface ActivityBatchGroup {
  label: string;
  count: number;
}

interface ActivityItemSummary {
  groupLabel: string;
  rawMarker: string | null;
  severity: RunnerActivitySeverity;
}

interface ActivityItemsProjection {
  visibleItems: readonly ActivityDisplayItem[];
  headerCount: number;
  severityCounts: Readonly<Record<RunnerActivitySeverity, number>>;
  groups: readonly ActivityBatchGroup[];
  rawMarkers: number;
}

export function buildActivityBatchViewModel(input: {
  events: readonly RunnerActivityEvent[];
  batchKey: string;
  expanded?: boolean;
}): ActivityBatchViewModel {
  const expanded = input.expanded === true;
  const events = input.events.filter(
    (event): event is VisibleRunnerActivityEvent => event.kind !== 'session',
  );
  const projection = expanded
    ? expandedActivityItemsProjection(events)
    : collapsedActivityItemsProjection(events, COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
  const hiddenCount = Math.max(0, projection.headerCount - COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
  const headerText = activityBatchHeader(events, projection.headerCount, projection.severityCounts);
  const latest = events.at(-1);

  return {
    batchKey: input.batchKey,
    visibleItems: projection.visibleItems,
    expanded,
    hiddenCount,
    headerCount: projection.headerCount,
    headerText,
    headerRunner:
      latest === undefined
        ? null
        : formatRecordedSeatIdentity({ ...latest, role: runnerActivityModelRole(latest.role) }),
    tone: activityBatchTone(events),
    renderableUnits: projection.headerCount,
    expandableKey: hiddenCount > 0 ? input.batchKey : null,
    severityCounts: projection.severityCounts,
    groups: projection.groups,
    rawMarkers: projection.rawMarkers,
  };
}

export function runnerActivityDisplayKey(event: RunnerActivityEvent): string | null {
  if (event.kind === 'session') return null;
  return runnerActivityLedgerItem({ ...event, kind: event.kind }).visibleKey;
}

function activityLedgerItems(
  events: readonly VisibleRunnerActivityEvent[],
): RunnerActivityLedgerItem[] {
  const items = new Map<string, RunnerActivityLedgerItem>();
  for (const event of events) {
    const item = runnerActivityLedgerItem(event);
    if (items.has(item.visibleKey)) items.delete(item.visibleKey);
    items.set(item.visibleKey, item);
  }
  return Array.from(items.values());
}

function expandedActivityItemsProjection(
  events: readonly VisibleRunnerActivityEvent[],
): ActivityItemsProjection {
  const items = activityLedgerItems(events);
  const summaries = items.map(activityItemSummary);
  return {
    visibleItems: items.map(activityDisplayItem),
    headerCount: items.length,
    severityCounts: activitySeverityCounts(summaries),
    groups: activityGroups(summaries),
    rawMarkers: activityRawMarkerCount(summaries),
  };
}

function collapsedActivityItemsProjection(
  events: readonly VisibleRunnerActivityEvent[],
  maxItems: number,
): ActivityItemsProjection {
  const summaries = new Map<string, ActivityItemSummary>();
  const recent = new Map<string, RunnerActivityLedgerItem>();

  for (const event of events) {
    const item = runnerActivityLedgerItem(event);
    summaries.set(item.visibleKey, activityItemSummary(item));
    if (recent.has(item.visibleKey)) recent.delete(item.visibleKey);
    recent.set(item.visibleKey, item);
    trimRecentActivityItems(recent, maxItems);
  }

  return {
    visibleItems: Array.from(recent.values()).map(activityDisplayItem),
    headerCount: summaries.size,
    severityCounts: activitySeverityCounts(summaries.values()),
    groups: activityGroups(summaries.values()),
    rawMarkers: activityRawMarkerCount(summaries.values()),
  };
}

function activityDisplayItem(display: RunnerActivityLedgerItem): ActivityDisplayItem {
  return {
    key: display.visibleKey,
    label: display.label,
    value: display.value,
    labelTone: activityLabelTone(display.label, display.severity),
    valueTone: toneToConversationTone(display.valueTone),
    fitMode: display.fitMode,
    severity: display.severity,
    rawMarker: display.rawMarker,
    groupLabel: display.groupLabel,
  };
}

function activityBatchHeader(
  events: readonly RunnerActivityEvent[],
  headerCount: number,
  severityCounts: Readonly<Record<RunnerActivitySeverity, number>>,
): string | null {
  const latest = events.at(-1);
  if (latest === undefined) return null;

  const warnings = severityCounts.warning;
  const errors = severityCounts.error;
  const roleLabel = `${runnerActivityRoleLabel(latest.role)} activity`;
  return [
    roleLabel,
    countNoun(headerCount, 'update'),
    warnings > 0 ? `${warnings} warn` : null,
    errors > 0 ? `${errors} err` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('  ');
}

function activityItemSummary(item: ActivityItemSummary): ActivityItemSummary {
  return {
    groupLabel: item.groupLabel,
    rawMarker: item.rawMarker,
    severity: item.severity,
  };
}

function trimRecentActivityItems(
  items: Map<string, RunnerActivityLedgerItem>,
  maxItems: number,
): void {
  while (items.size > maxItems) {
    const oldest = items.keys().next();
    if (oldest.done === true) return;
    items.delete(oldest.value);
  }
}

function activitySeverityCounts(
  items: Iterable<ActivityItemSummary>,
): Readonly<Record<RunnerActivitySeverity, number>> {
  const counts: Record<RunnerActivitySeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

function activityRawMarkerCount(items: Iterable<ActivityItemSummary>): number {
  let count = 0;
  for (const item of items) {
    if (item.rawMarker !== null) count += 1;
  }
  return count;
}

function activityGroups(items: Iterable<ActivityItemSummary>): ActivityBatchGroup[] {
  const groups = new Map<string, number>();
  for (const item of items) groups.set(item.groupLabel, (groups.get(item.groupLabel) ?? 0) + 1);
  return Array.from(groups, ([label, count]) => ({ label, count }));
}

export function toneToConversationTone(
  tone: 'info' | 'success' | 'warning' | 'error' | 'textDim',
): ConversationRowTone {
  switch (tone) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'textDim':
      return 'textDim';
    default:
      return assertNever(tone);
  }
}

function activityLabelTone(
  label: RunnerActivityLedgerLabel,
  severity: RunnerActivitySeverity,
): ConversationRowTone {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  switch (label) {
    case 'RUN':
    case 'CALL':
    case 'EDIT':
      return 'accent';
    case 'PLAN':
      return 'planner';
    case 'ART':
      return 'info';
    case 'READ':
    case 'FIND':
    case 'LIST':
      return 'textDim';
    case 'WARN':
      return 'warning';
    case 'ERR':
      return 'error';
    default:
      return assertNever(label);
  }
}

export function activityBatchTone(events: readonly RunnerActivityEvent[]): ConversationRowTone {
  switch (events.at(-1)?.role) {
    case 'planner':
      return 'planner';
    case 'implementer':
      return 'implementer';
    case 'review':
      return 'validator';
    default:
      return 'textDim';
  }
}
