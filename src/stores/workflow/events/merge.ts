import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { endsBaseCommand, suiteCommandKey } from '../operations/state.js';
import { projectEventForTuiEventLog } from './project.js';

export const MAX_EVENTS = 10_000;
export const MAX_MERGED_TEXT_LENGTH = 500_000;

const COMMAND_BOUNDARIES: ReadonlySet<EngineEvent['type']> = new Set([
  'turn_interrupted',
  'workflow_cancelled',
  'workflow_resumed',
]);

type CommandEvent = EngineEventOf<'full_suite' | 'validate'>;

function isBaseCommand(event: CommandEvent): boolean {
  return event.type === 'full_suite' && event.moment === 'base';
}

// A stop, an end, a continue, a steer or a cut seat call, or the reopen of a run whose process went
// away: a command still running then never finishes. A base command ends only where
// `endsBaseCommand` says.
function commandsEndedBy(event: EngineEvent): ((command: CommandEvent) => boolean) | null {
  if (endsBaseCommand(event)) return () => true;
  if (!COMMAND_BOUNDARIES.has(event.type)) return null;
  return (command) => !isBaseCommand(command);
}

type LogMerge =
  | { readonly kind: 'drop' }
  | { readonly kind: 'replace'; readonly index: number; readonly event: EngineEvent }
  | { readonly kind: 'append' };

const DROP_LOG_MERGE: LogMerge = { kind: 'drop' };
const APPEND_LOG_MERGE: LogMerge = { kind: 'append' };

// Text joins the text row it continues. Both live and replay logs use the same rule.
function mergeIntoLog(
  events: readonly EngineEvent[],
  event: EngineEvent,
  dropped?: readonly boolean[],
): LogMerge {
  if (event.type === 'runner_call_text_delta') return DROP_LOG_MERGE;
  if (event.type !== 'planner_text') return APPEND_LOG_MERGE;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (dropped?.[index] === true) continue;
    const row = events[index];
    if (event.continues === true && row?.type === 'runner_call_activity') continue;
    // A sub-agent's held end also passes the text of other sub-agents that spoke during its hold.
    if (
      event.continues === true &&
      event.subagentId !== undefined &&
      row?.type === 'planner_text' &&
      row.subagentId !== undefined &&
      row.subagentId !== event.subagentId
    )
      continue;
    if (row?.type !== 'planner_text' || !joinsTextRow(row, event)) return APPEND_LOG_MERGE;
    const joined = row.text + event.text;
    const text =
      joined.length > MAX_MERGED_TEXT_LENGTH ? joined.slice(-MAX_MERGED_TEXT_LENGTH) : joined;
    return { kind: 'replace', index, event: { ...row, text } };
  }
  return APPEND_LOG_MERGE;
}

function joinsTextRow(
  row: EngineEventOf<'planner_text'>,
  event: EngineEventOf<'planner_text'>,
): boolean {
  return (
    !(event.role === 'implementer' && event.messageStart === true) &&
    (row.role ?? 'planner') === (event.role ?? 'planner') &&
    (row.content ?? 'plain') === (event.content ?? 'plain') &&
    row.subagentId === event.subagentId
  );
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
  const ended = commandsEndedBy(event);
  if (ended !== null) {
    events = events.slice();
    settleStoppedCommands(events, ended);
  }
  const commandIndex = commandReplacementIndex(events, event);
  if (commandIndex >= 0) {
    const next = events.slice();
    next[commandIndex] = event;
    return next;
  }
  const merge = mergeIntoLog(events, event);
  if (merge.kind === 'drop') return events;
  if (merge.kind === 'replace') {
    const next = events.slice();
    next[merge.index] = merge.event;
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

// The batch form of mergeEvent uses the same projection, command and text merges, and eviction
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
    const ended = commandsEndedBy(projected);
    if (ended !== null) settleStoppedCommands(log, ended, runningCommands);
    const commandIndex = commandReplacementIndex(log, projected, runningCommands);
    if (commandIndex >= 0) {
      log[commandIndex] = projected;
      updateRunningCommandIndex(runningCommands, projected, commandIndex);
      continue;
    }
    const merge = mergeIntoLog(log, projected, dropped);
    if (merge.kind === 'drop') continue;
    if (merge.kind === 'replace') {
      log[merge.index] = merge.event;
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

function settleStoppedCommands(
  events: EngineEvent[],
  ended: (command: CommandEvent) => boolean,
  runningCommands?: Map<string, number>,
): void {
  const running = runningCommands ?? new Map<string, number>();
  if (runningCommands === undefined) {
    for (const [index, event] of events.entries()) {
      updateRunningCommandIndex(running, event, index);
    }
  }
  for (const [key, index] of running) {
    const event = events[index];
    if ((event?.type === 'full_suite' || event?.type === 'validate') && ended(event)) {
      events[index] = { ...event, status: 'stopped' };
      running.delete(key);
    }
  }
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
    case 'user_message':
    case 'warning':
      return true;
    default:
      return false;
  }
}
