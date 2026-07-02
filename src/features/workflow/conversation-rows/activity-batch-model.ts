import { formatToolModel } from '../../../core/model-display.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ActivityDisplayValueFit } from '../display/activity-display-text.js';
import {
  runnerActivityLedgerItem,
  runnerActivityRoleLabel,
  runnerActivitySeverityRank,
  type RunnerActivityLedgerItem,
  type RunnerActivityLedgerLabel,
  type RunnerActivitySeverity,
} from '../display/runner-activity-display.js';
import type { ConversationRowTone } from './types.js';

export const COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT = 3;

export type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

export interface ActivityDisplayItem {
  key: string;
  label: RunnerActivityLedgerLabel;
  value: string;
  labelTone: ConversationRowTone;
  valueTone: ConversationRowTone;
  fitMode: ActivityDisplayValueFit;
  severity: RunnerActivitySeverity;
  pinned: boolean;
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
  const projection = expanded
    ? expandedActivityItemsProjection(input.events)
    : collapsedActivityItemsProjection(input.events, COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
  const hiddenCount = Math.max(0, projection.headerCount - COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
  const headerText = activityBatchHeader(
    input.events,
    projection.headerCount,
    projection.severityCounts,
  );

  return {
    batchKey: input.batchKey,
    visibleItems: projection.visibleItems,
    expanded,
    hiddenCount,
    headerCount: projection.headerCount,
    headerText,
    tone: activityBatchTone(input.events),
    renderableUnits: projection.headerCount,
    expandableKey: hiddenCount > 0 ? input.batchKey : null,
    severityCounts: projection.severityCounts,
    groups: projection.groups,
    rawMarkers: projection.rawMarkers,
  };
}

export function runnerActivityDisplayKey(event: RunnerActivityEvent): string {
  return runnerActivityLedgerItem(event).visibleKey;
}

function activityLedgerItems(events: readonly RunnerActivityEvent[]): RunnerActivityLedgerItem[] {
  const items = new Map<string, RunnerActivityLedgerItem>();
  for (const event of events) {
    const item = runnerActivityLedgerItem(event);
    if (items.has(item.visibleKey)) items.delete(item.visibleKey);
    items.set(item.visibleKey, item);
  }
  return Array.from(items.values());
}

function expandedActivityItemsProjection(
  events: readonly RunnerActivityEvent[],
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
  events: readonly RunnerActivityEvent[],
  maxItems: number,
): ActivityItemsProjection {
  const summaries = new Map<string, ActivityItemSummary>();
  const pinnedCandidates = new Map<string, RunnerActivityLedgerItem>();
  const recent = new Map<string, RunnerActivityLedgerItem>();

  for (const event of events) {
    const item = runnerActivityLedgerItem(event);
    summaries.set(item.visibleKey, activityItemSummary(item));
    if (recent.has(item.visibleKey)) recent.delete(item.visibleKey);
    recent.set(item.visibleKey, item);
    trimRecentActivityItems(recent, maxItems);
    if (pinnedCandidates.has(item.visibleKey)) pinnedCandidates.delete(item.visibleKey);
    if (item.pinned) {
      pinnedCandidates.set(item.visibleKey, item);
    }
  }

  return {
    visibleItems: collapsedActivityItems({
      recent: Array.from(recent.values()),
      pinned: selectPinnedActivityItem(pinnedCandidates.values()),
      totalCount: summaries.size,
      maxItems,
    }).map(activityDisplayItem),
    headerCount: summaries.size,
    severityCounts: activitySeverityCounts(summaries.values()),
    groups: activityGroups(summaries.values()),
    rawMarkers: activityRawMarkerCount(summaries.values()),
  };
}

function selectPinnedActivityItem(
  items: Iterable<RunnerActivityLedgerItem>,
): RunnerActivityLedgerItem | null {
  let pinned: RunnerActivityLedgerItem | null = null;
  for (const item of items) {
    if (
      pinned === null ||
      runnerActivitySeverityRank(item.severity) >= runnerActivitySeverityRank(pinned.severity)
    ) {
      pinned = item;
    }
  }
  return pinned;
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
    pinned: display.pinned,
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

  const tool = sanitizeTerminalDisplayText(formatToolModel(latest.runnerName, latest.model));
  const warnings = severityCounts.warning;
  const errors = severityCounts.error;
  const roleLabel = `${runnerActivityRoleLabel(latest.role)} activity`;
  return [
    roleLabel,
    countNoun(headerCount, 'update'),
    warnings > 0 ? `${warnings} warn` : null,
    errors > 0 ? `${errors} err` : null,
    tool ? `[${tool}]` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('  ');
}

function collapsedActivityItems(input: {
  recent: readonly RunnerActivityLedgerItem[];
  pinned: RunnerActivityLedgerItem | null;
  totalCount: number;
  maxItems: number;
}): RunnerActivityLedgerItem[] {
  if (input.totalCount <= input.maxItems) return [...input.recent];
  const visible: RunnerActivityLedgerItem[] = [];
  if (input.pinned) visible.push(input.pinned);

  const remaining = input.maxItems - visible.length;
  if (remaining <= 0) return visible;

  const recentWithoutPinned = input.recent.filter(
    (item) => item.visibleKey !== input.pinned?.visibleKey,
  );
  visible.push(...recentWithoutPinned.slice(-remaining));
  return visible;
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
    case 'SESS':
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
