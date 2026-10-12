import { createStore, storeBase } from '../create-store.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import {
  sanitizeTerminalDiagnosticText,
  sanitizeTerminalDisplayText,
} from '../../utils/display-text.js';
import { suiteCommandKey } from './operations/state.js';

export interface EventsState {
  events: EngineEvent[];
}

const initial: EventsState = { events: [] };

const store = createStore<EventsState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<EventsState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions/ (the dispatcher).
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
    case 'runner_call_runtime_status':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
    case 'runner_call_stalled':
    case 'runner_call_stall_cleared':
    case 'runner_call_heartbeat':
      return null;
    case 'planner_heartbeat':
      return null;
    // The plan announcement drives the task stores, not a transcript row, and it is republished on
    // every resume and re-attach. Keeping it out of the capped log spends no entries on a payload
    // nothing renders.
    case 'tasks_planned':
      return null;
    case 'warning':
      return { ...event, message: sanitizeTerminalDiagnosticText(event.message) };
    case 'error':
      return { ...event, message: sanitizeTerminalDiagnosticText(event.message) };
    default:
      return event;
  }
}

type TailMerge =
  | { readonly kind: 'drop' }
  | { readonly kind: 'replace'; readonly event: EngineEvent }
  | { readonly kind: 'append' };

const DROP_TAIL_MERGE: TailMerge = { kind: 'drop' };
const APPEND_TAIL_MERGE: TailMerge = { kind: 'append' };

// Text deltas merge only at the tail. Both live and replay logs use the same rule.
function mergeIntoTail(last: EngineEvent | undefined, event: EngineEvent): TailMerge {
  if (event.type === 'runner_call_text_delta') return DROP_TAIL_MERGE;
  if (
    event.type === 'planner_text' &&
    last?.type === 'planner_text' &&
    !(event.role === 'implementer' && event.messageStart === true) &&
    (last.role ?? 'planner') === (event.role ?? 'planner') &&
    (last.content ?? 'plain') === (event.content ?? 'plain')
  ) {
    const joined = last.text + event.text;
    const text =
      joined.length > MAX_MERGED_TEXT_LENGTH ? joined.slice(-MAX_MERGED_TEXT_LENGTH) : joined;
    return { kind: 'replace', event: { ...last, text } };
  }
  return APPEND_TAIL_MERGE;
}

function commandKey(event: EngineEventOf<'full_suite' | 'validate'>): string {
  return event.type === 'full_suite'
    ? `suite:${suiteCommandKey(event)}`
    : `validate:${event.taskId}`;
}

// Running updates and verdicts take their command's slot even across an intervening warning.
function commandReplacementIndex(
  events: readonly EngineEvent[],
  event: EngineEvent,
  runningCommands?: ReadonlyMap<string, number>,
): number {
  if (event.type !== 'full_suite' && event.type !== 'validate') return -1;
  const key = commandKey(event);
  if (runningCommands !== undefined) return runningCommands.get(key) ?? -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const running = events[index];
    if (
      (running?.type === 'full_suite' || running?.type === 'validate') &&
      running.status === 'running' &&
      commandKey(running) === key
    ) {
      return index;
    }
  }
  return -1;
}

function updateRunningCommandIndex(
  runningCommands: Map<string, number>,
  event: EngineEvent,
  index: number,
): void {
  if (event.type !== 'full_suite' && event.type !== 'validate') return;
  const key = commandKey(event);
  if (event.status === 'running') runningCommands.set(key, index);
  else runningCommands.delete(key);
}

export function mergeEvent(events: EngineEvent[], event: EngineEvent): EngineEvent[] {
  if (repeatsCallError(events, event)) return events;
  if (event.type === 'turn_interrupted' || event.type === 'workflow_cancelled') {
    events = events.slice();
    settleStoppedCommands(events);
  }
  const commandIndex = commandReplacementIndex(events, event);
  if (commandIndex >= 0) {
    const next = events.slice();
    next[commandIndex] = event;
    return next;
  }
  const merge = mergeIntoTail(events[events.length - 1], event);
  if (merge.kind === 'drop') return events;
  if (merge.kind === 'replace') {
    const next = events.slice();
    next[next.length - 1] = merge.event;
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

// The batch form of mergeEvent uses the same projection, command and tail merges, and eviction
// order. It marks survivors in place and materializes once, so a 50k-event log costs one pass
// rather than one whole-array copy per event past the cap.
export function mergeEventLog(events: EngineEvent[]): EngineEvent[] {
  const log: EngineEvent[] = [];
  const dropped: boolean[] = [];
  const runningCommands = new Map<string, number>();
  let live = 0;
  let evictable = 0;
  let oldest = 0;

  for (const event of events) {
    const projected = projectEventForTuiEventLog(event);
    if (projected === null) continue;
    if (projected.type === 'turn_interrupted' || projected.type === 'workflow_cancelled') {
      settleStoppedCommands(log, runningCommands);
    }
    const commandIndex = commandReplacementIndex(log, projected, runningCommands);
    if (commandIndex >= 0) {
      log[commandIndex] = projected;
      updateRunningCommandIndex(runningCommands, projected, commandIndex);
      continue;
    }
    const merge = mergeIntoTail(log[log.length - 1], projected);
    if (merge.kind === 'drop') continue;
    if (merge.kind === 'replace') {
      log[log.length - 1] = merge.event;
      continue;
    }
    if (live >= MAX_EVENTS) {
      evictable = nextEvictableIndex(log, dropped, evictable);
      let evictionIndex = evictable;
      if (evictable < log.length) {
        evictable += 1;
      } else {
        oldest = nextSurvivingIndex(dropped, oldest, log.length);
        evictionIndex = oldest;
        oldest += 1;
      }
      const evicted = log[evictionIndex];
      if (
        (evicted?.type === 'full_suite' || evicted?.type === 'validate') &&
        commandReplacementIndex(log, evicted, runningCommands) === evictionIndex
      ) {
        runningCommands.delete(commandKey(evicted));
      }
      dropped[evictionIndex] = true;
      live -= 1;
    }
    updateRunningCommandIndex(runningCommands, projected, log.length);
    log.push(projected);
    dropped.push(false);
    live += 1;
  }

  return log.filter((_, index) => dropped[index] !== true);
}

// A run reopened at rest shows the calls its process left open as interrupted, read off its log
// (`interruptedCallEvents`); continuing or ending it records that same close on the bus. A call ends once, so
// the repeat is dropped. Call ids restart with each process, so the search stops at the run's
// latest start or resume.
function repeatsCallError(events: readonly EngineEvent[], event: EngineEvent): boolean {
  if (event.type !== 'runner_call_activity' || event.kind !== 'error') return false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const earlier = events[index];
    if (earlier?.type === 'workflow_started' || earlier?.type === 'workflow_resumed') return false;
    if (
      earlier?.type === 'runner_call_activity' &&
      earlier.activityId === event.activityId &&
      earlier.ts === event.ts
    ) {
      return true;
    }
  }
  return false;
}

function settleStoppedCommands(events: EngineEvent[], runningCommands?: Map<string, number>): void {
  const running = runningCommands ?? new Map<string, number>();
  if (runningCommands === undefined) {
    for (const [index, event] of events.entries()) {
      updateRunningCommandIndex(running, event, index);
    }
  }
  for (const index of running.values()) {
    const event = events[index];
    if (event?.type === 'full_suite' || event?.type === 'validate') {
      events[index] = { ...event, status: 'stopped' };
    }
  }
  running.clear();
}

// Both scans resume where the last one stopped: an entry already passed over is structural or
// dropped for the rest of the fold, so neither cursor ever walks backwards.
function nextEvictableIndex(
  log: readonly EngineEvent[],
  dropped: readonly boolean[],
  from: number,
): number {
  for (let index = from; index < log.length; index += 1) {
    const event = log[index];
    if (event === undefined || dropped[index] === true) continue;
    if (!isStructuralTranscriptEvent(event)) return index;
  }
  return log.length;
}

function nextSurvivingIndex(dropped: readonly boolean[], from: number, end: number): number {
  for (let index = from; index < end; index += 1) {
    if (dropped[index] !== true) return index;
  }
  return end;
}

function projectRunnerActivityForTuiEventLog(
  event: EngineEventOf<'runner_call_activity'>,
): EngineEventOf<'runner_call_activity'> | null {
  if (event.kind === 'session') return null;
  const label = cleanRequiredTuiEventLogText(event.label);
  if (label === null) return null;

  const target = cleanOptionalTuiEventLogText(event.target);
  const textPartial = cleanOptionalTuiEventLogText(event.textPartial);
  const diagnosticPartial = cleanOptionalTuiEventLogText(event.diagnosticPartial);
  const rawAvailable = event.rawAvailable === true;
  const runnerName = cleanOptionalTuiEventLogText(event.runnerName);
  const model = cleanOptionalTuiEventLogText(event.model);
  const axes = event.axes?.map(cleanOptionalTuiEventLogText).filter((axis) => axis !== undefined);
  const originalModel = cleanOptionalTuiEventLogText(event.originalModel);
  const fallbackModel = cleanOptionalTuiEventLogText(event.fallbackModel);
  const redacted =
    event.redacted ||
    label.changed ||
    target?.changed === true ||
    textPartial?.changed === true ||
    diagnosticPartial?.changed === true ||
    runnerName?.changed === true ||
    model?.changed === true ||
    axes?.some((axis) => axis.changed) === true ||
    originalModel?.changed === true ||
    fallbackModel?.changed === true;

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
    ...(axes !== undefined && { axes: axes.map((axis) => axis.text) }),
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
    ...(originalModel !== undefined && { originalModel: originalModel.text }),
    ...(fallbackModel !== undefined && { fallbackModel: fallbackModel.text }),
  };
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
