import { createStore, storeBase } from '../create-store.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import {
  sanitizeTerminalDiagnosticText,
  sanitizeTerminalDisplayText,
} from '../../utils/display-text.js';

export interface EventsState {
  events: EngineEvent[];
}

const initial: EventsState = { events: [] };

const store = createStore<EventsState>(initial);
const SESSION_ACTIVITY_LABEL = 'session captured';

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<EventsState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions.ts (the dispatcher).
export const _eventsInternal = { set: store.set };

export const eventsStore = {
  ...storeBase(store),
  __testReset,
};

export const MAX_EVENTS = 10_000;
export const MAX_MERGED_TEXT_LENGTH = 500_000;

export function projectEventForTuiEventLog(event: EngineEvent): EngineEvent | null {
  switch (event.type) {
    case 'runner_call_activity':
      return projectRunnerActivityForTuiEventLog(event);
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
      return null;
    case 'warning':
      return { ...event, message: sanitizeTerminalDiagnosticText(event.message) };
    case 'error':
      return { ...event, message: sanitizeTerminalDiagnosticText(event.message) };
    default:
      return event;
  }
}

export function mergeEvent(events: EngineEvent[], event: EngineEvent): EngineEvent[] {
  if (event.type === 'runner_call_text_delta') return events;

  const last = events[events.length - 1];
  if (
    event.type === 'planner_text' &&
    last?.type === 'planner_text' &&
    (last.role ?? 'planner') === (event.role ?? 'planner') &&
    (last.content ?? 'plain') === (event.content ?? 'plain')
  ) {
    let mergedText = last.text + event.text;
    if (mergedText.length > MAX_MERGED_TEXT_LENGTH) {
      mergedText = mergedText.slice(-MAX_MERGED_TEXT_LENGTH);
    }
    const merged = { ...last, text: mergedText };
    const next = events.slice();
    next[next.length - 1] = merged;
    return next;
  }
  if (
    event.type === 'validate' &&
    event.status === 'running' &&
    last?.type === 'validate' &&
    last.status === 'running'
  ) {
    const next = events.slice();
    next[next.length - 1] = event;
    return next;
  }
  if (event.type === 'planner_heartbeat' && last?.type === 'planner_heartbeat') {
    const next = events.slice();
    next[next.length - 1] = event;
    return next;
  }
  if (events.length >= MAX_EVENTS) {
    const evictionIndex = firstEvictableEventIndex(events);
    const kept =
      evictionIndex < 0
        ? events.slice(1)
        : [...events.slice(0, evictionIndex), ...events.slice(evictionIndex + 1)];
    return [...kept, event];
  }
  return [...events, event];
}

function projectRunnerActivityForTuiEventLog(
  event: EngineEventOf<'runner_call_activity'>,
): EngineEventOf<'runner_call_activity'> | null {
  const label = cleanRequiredTuiEventLogText(safeRunnerActivityLabel(event));
  if (label === null) return null;

  const target = event.kind === 'session' ? undefined : cleanOptionalTuiEventLogText(event.target);
  const textPartial =
    event.kind === 'session' ? undefined : cleanOptionalTuiEventLogText(event.textPartial);
  const diagnosticPartial =
    event.kind === 'session' ? undefined : cleanOptionalTuiEventLogText(event.diagnosticPartial);
  const rawAvailable = event.kind === 'session' ? false : event.rawAvailable === true;
  const runnerName = cleanOptionalTuiEventLogText(event.runnerName);
  const model = cleanOptionalTuiEventLogText(event.model);
  const redacted =
    event.redacted ||
    label.changed ||
    target?.changed === true ||
    textPartial?.changed === true ||
    diagnosticPartial?.changed === true ||
    runnerName?.changed === true ||
    model?.changed === true;

  return {
    type: 'runner_call_activity',
    ts: event.ts,
    phase: event.phase,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    ...(runnerName !== undefined && { runnerName: runnerName.text }),
    ...(model !== undefined && { model: model.text }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    sequence: event.sequence,
    activityId: event.activityId,
    stage: event.stage,
    kind: event.kind,
    label: label.text,
    ...(target !== undefined && { target: target.text }),
    redacted,
    ...(rawAvailable && { rawAvailable: true }),
    ...(textPartial !== undefined && { textPartial: textPartial.text }),
    ...(diagnosticPartial !== undefined && { diagnosticPartial: diagnosticPartial.text }),
  };
}

function safeRunnerActivityLabel(event: EngineEventOf<'runner_call_activity'>): string {
  return event.kind === 'session' ? SESSION_ACTIVITY_LABEL : event.label;
}

function cleanRequiredTuiEventLogText(
  value: string,
): { readonly text: string; readonly changed: boolean } | null {
  const clean = sanitizeTerminalDisplayText(value);
  if (clean.length === 0) return null;
  return { text: clean, changed: clean !== value };
}

function cleanOptionalTuiEventLogText(
  value: string | undefined,
): { readonly text: string; readonly changed: boolean } | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeTerminalDisplayText(value);
  return clean.length === 0 ? undefined : { text: clean, changed: clean !== value };
}

function firstEvictableEventIndex(events: readonly EngineEvent[]): number {
  return events.findIndex((event) => !isStructuralTranscriptEvent(event));
}

function isStructuralTranscriptEvent(event: EngineEvent): boolean {
  switch (event.type) {
    case 'workflow_started':
    case 'workflow_resumed':
    case 'workflow_config':
    case 'task_started':
    case 'task_completed':
    case 'task_skipped':
    case 'task_full_fail':
      return true;
    default:
      return false;
  }
}
