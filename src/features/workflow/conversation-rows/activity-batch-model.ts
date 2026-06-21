import { formatToolModel } from '../../../core/model-display.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { shellCommandFromText } from '../../../utils/shell-quote.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ActivityDisplayValueFit } from '../display/activity-display-text.js';
import { runnerActivityDiagnosticPreview } from '../display/runner-terminal.js';
import { sanitizeWorkflowDisplayText } from '../display/safe-text.js';
import type { ConversationRowTone } from './types.js';

export const COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT = 3;

export type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

export interface ActivityDisplayItem {
  key: string;
  label: string;
  value: string;
  labelTone: ConversationRowTone;
  valueTone: ConversationRowTone;
  fitMode: ActivityDisplayValueFit;
}

export interface ActivityBatchViewModel {
  batchKey: string;
  allItems: readonly ActivityDisplayItem[];
  visibleItems: readonly ActivityDisplayItem[];
  hiddenCount: number;
  headerCount: number;
  headerText: string | null;
  tone: ConversationRowTone;
  renderableUnits: number;
  expandableKey: string | null;
}

export function buildActivityBatchViewModel(input: {
  events: readonly RunnerActivityEvent[];
  batchKey: string;
  expanded?: boolean;
}): ActivityBatchViewModel {
  const allItems = activityItems(input.events);
  const hiddenCount = Math.max(0, allItems.length - COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
  const visibleItems =
    input.expanded === true ? allItems : allItems.slice(-COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
  const headerCount = allItems.length;

  return {
    batchKey: input.batchKey,
    allItems,
    visibleItems,
    hiddenCount,
    headerCount,
    headerText: activityBatchHeader(input.events, headerCount),
    tone: activityBatchTone(input.events),
    renderableUnits: headerCount,
    expandableKey: hiddenCount > 0 ? input.batchKey : null,
  };
}

export function runnerActivityDisplayKey(event: RunnerActivityEvent): string {
  return activityDisplayItem(event).key;
}

function activityItems(events: readonly RunnerActivityEvent[]): ActivityDisplayItem[] {
  const items: ActivityDisplayItem[] = [];
  for (const event of events) {
    const item = activityDisplayItem(event);
    const existingIndex = items.findIndex((current) => current.key === item.key);
    if (existingIndex >= 0) items.splice(existingIndex, 1);
    items.push(item);
  }
  return items;
}

function activityDisplayItem(event: RunnerActivityEvent): ActivityDisplayItem {
  const raw = event.target ?? event.label;
  const withoutVerb = stripActivityVerb(raw);
  const value = activityValue(event);
  const label = activityLabel(
    event,
    shellCommandFromText(withoutVerb) !== null || shellCommandFromText(raw) !== null,
  );

  return {
    key: [label, value].join('\u0000'),
    label,
    value,
    labelTone: activityTone(event.stage),
    valueTone: activityValueTone(event.stage),
    fitMode: activityFitMode(label, event),
  };
}

function activityValue(event: RunnerActivityEvent): string {
  if (isUserInterruptedActivity(event)) return 'current turn interrupted';

  const source = event.target ?? event.label;
  const withoutVerb = stripActivityVerb(source);
  const primary = shellCommandFromText(withoutVerb) ?? shellCommandFromText(source) ?? withoutVerb;
  const detail = runnerActivityDiagnosticPreview(event);
  if (detail === null || primary.includes(detail)) return primary;
  return `${primary}: ${detail}`;
}

function stripActivityVerb(text: string): string {
  const prefixes = [
    'aborted ',
    'running ',
    'reading ',
    'editing ',
    'searching ',
    'matching ',
    'calling ',
    'planning ',
    'session ',
    'artifact ',
    'warning ',
    'failed ',
    'timeout ',
    'truncated ',
    'refused ',
    'unsupported_tool ',
    'incomplete ',
  ];
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return text;
}

function activityLabel(event: RunnerActivityEvent, shellCommand: boolean): string {
  if (isUserInterruptedActivity(event)) return 'interrupted';
  if (shellCommand) return 'run';

  switch (event.kind) {
    case 'tool':
      return 'tool';
    case 'file':
      return 'file';
    case 'text':
      return 'text';
    case 'command':
      return 'run';
    case 'read':
      return 'read';
    case 'write':
    case 'edit':
      return 'edit';
    case 'search':
    case 'glob':
      return 'search';
    case 'task':
      return 'task';
    case 'web':
    case 'mcp':
      return 'call';
    case 'plan':
      return 'plan';
    case 'session':
      return 'session';
    case 'artifact':
      return 'artifact';
    case 'warning':
      return 'warning';
    case 'error':
      if (event.stage === 'aborted') return 'interrupted';
      return 'error';
    case 'unknown':
      return 'activity';
    default:
      return assertNever(event.kind);
  }
}

function isUserInterruptedActivity(event: RunnerActivityEvent): boolean {
  return (
    event.stage === 'aborted' &&
    event.kind === 'error' &&
    event.label.includes('runner_interrupted')
  );
}

function activityFitMode(label: string, event: RunnerActivityEvent): ActivityDisplayValueFit {
  if (label === 'run') return 'middle';
  if (event.kind === 'read' || event.kind === 'write' || event.kind === 'edit') return 'start';
  if (event.kind === 'warning' || event.kind === 'error') return 'middle';
  return 'end';
}

function activityTone(stage: RunnerActivityEvent['stage']): ConversationRowTone {
  switch (stage) {
    case 'started':
    case 'updated':
      return 'info';
    case 'completed':
      return 'success';
    case 'warning':
    case 'aborted':
    case 'timeout':
    case 'truncated':
    case 'incomplete':
      return 'warning';
    case 'failed':
    case 'refused':
    case 'unsupported_tool':
      return 'error';
    default:
      return assertNever(stage);
  }
}

function activityValueTone(stage: RunnerActivityEvent['stage']): ConversationRowTone {
  switch (stage) {
    case 'started':
    case 'updated':
    case 'completed':
      return 'textDim';
    case 'warning':
    case 'aborted':
    case 'timeout':
    case 'truncated':
    case 'incomplete':
      return 'warning';
    case 'failed':
    case 'refused':
    case 'unsupported_tool':
      return 'error';
    default:
      return assertNever(stage);
  }
}

function activityBatchHeader(
  events: readonly RunnerActivityEvent[],
  headerCount: number,
): string | null {
  if (headerCount <= 1) return null;

  const latest = events.at(-1);
  if (latest === undefined) return null;

  const tool = sanitizeWorkflowDisplayText(formatToolModel(latest.runnerName, latest.model));
  return [
    `${latest.role} activity`,
    `${headerCount} ${headerCount === 1 ? 'update' : 'updates'}`,
    tool ? `[${tool}]` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('  ');
}

function activityBatchTone(events: readonly RunnerActivityEvent[]): ConversationRowTone {
  const role = events.at(-1)?.role;
  switch (role) {
    case 'implementer':
      return 'implementer';
    case 'planner':
    case 'review':
    case 'summary':
    case 'compaction':
    case 'escalation':
      return 'planner';
    case undefined:
      return 'text';
    default:
      return assertNever(role);
  }
}
