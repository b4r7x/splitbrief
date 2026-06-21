import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { createStore, storeBase } from '../create-store.js';

const MAX_ACTIVITY_ITEMS = 8;
const SESSION_ACTIVITY_LABEL = 'session captured';

type ActivityEvent =
  | EngineEventOf<'runner_call_activity'>
  | EngineEventOf<'runner_call_completed'>
  | EngineEventOf<'runner_call_error'>
  | EngineEventOf<'workflow_cancelled'>;

export interface WorkflowActivityItem {
  id: string;
  callId: string;
  taskId?: string;
  phase: Phase;
  role: EngineEventOf<'runner_call_started'>['role'];
  stage: EngineEventOf<'runner_call_activity'>['stage'];
  kind: EngineEventOf<'runner_call_activity'>['kind'];
  label: string;
  target?: string;
  runnerName?: string;
  model?: string;
  redacted: boolean;
  rawAvailable: boolean;
  expandId?: string;
  textPartial?: string;
  diagnosticPartial?: string;
  sequence: number;
  ts: number;
}

export interface ActivityState {
  items: readonly WorkflowActivityItem[];
}

const initial = (): ActivityState => ({ items: [] });

const store = createStore<ActivityState>(initial);

function __testReset(next?: Partial<ActivityState>): void {
  store.set(next ? { ...initial(), ...next } : initial());
}

export const _activityInternal = { set: store.set };

export const activityStore = {
  ...storeBase(store),
  __testReset,
};

export function updateActivity(state: ActivityState, event: EngineEvent): ActivityState {
  if (!isActivityEvent(event)) return state;
  if (event.type === 'workflow_cancelled') return { ...state, items: [] };
  if (event.type === 'runner_call_completed' || event.type === 'runner_call_error') {
    return retireRunningCallActivity(state, event.callId);
  }

  const isSessionActivity = event.kind === 'session';
  const rawAvailable = isSessionActivity ? false : (event.rawAvailable ?? false);
  const item: WorkflowActivityItem = {
    id: event.activityId,
    callId: event.callId,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    phase: event.phase,
    role: event.role,
    stage: event.stage,
    kind: event.kind,
    label: isSessionActivity ? SESSION_ACTIVITY_LABEL : event.label,
    ...(!isSessionActivity && event.target !== undefined && { target: event.target }),
    ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
    ...(event.model !== undefined && { model: event.model }),
    redacted: event.redacted,
    rawAvailable,
    ...(rawAvailable && { expandId: event.expandId ?? event.activityId }),
    ...(!isSessionActivity &&
      event.textPartial !== undefined && { textPartial: event.textPartial }),
    ...(!isSessionActivity &&
      event.diagnosticPartial !== undefined && { diagnosticPartial: event.diagnosticPartial }),
    sequence: event.sequence,
    ts: event.ts,
  };

  const items = [...state.items.filter((current) => current.id !== item.id), item].slice(
    -MAX_ACTIVITY_ITEMS,
  );
  return { ...state, items };
}

function isActivityEvent(event: EngineEvent): event is ActivityEvent {
  return (
    event.type === 'runner_call_activity' ||
    event.type === 'runner_call_completed' ||
    event.type === 'runner_call_error' ||
    event.type === 'workflow_cancelled'
  );
}

function retireRunningCallActivity(state: ActivityState, callId: string): ActivityState {
  const items = state.items.filter(
    (item) => item.callId !== callId || !isRunningActivityStage(item.stage),
  );
  return items.length === state.items.length ? state : { ...state, items };
}

function isRunningActivityStage(stage: WorkflowActivityItem['stage']): boolean {
  return stage === 'started' || stage === 'updated';
}
