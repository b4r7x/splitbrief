import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { createStore, storeBase } from '../create-store.js';

const MAX_ACTIVITY_ITEMS = 8;
const SESSION_ACTIVITY_LABEL = 'session captured';

type ActivityEvent =
  | EngineEventOf<'runner_call_activity'>
  | EngineEventOf<'runner_call_completed'>
  | EngineEventOf<'runner_call_error'>
  | EngineEventOf<'workflow_cancelled'>;

const SAFE_RUNNER_ACTIVITY: unique symbol = Symbol('safeRunnerActivity');

type SafeRunnerActivityEvent = Omit<
  EngineEventOf<'runner_call_activity'>,
  'label' | 'target' | 'textPartial' | 'diagnosticPartial'
> & {
  readonly [SAFE_RUNNER_ACTIVITY]: true;
  label: string;
  target?: string | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
};

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

  const safeEvent = safeRunnerActivityEvent(event);
  if (safeEvent === null) return state;

  const isSessionActivity = safeEvent.kind === 'session';
  const rawAvailable = isSessionActivity ? false : (safeEvent.rawAvailable ?? false);
  const item: WorkflowActivityItem = {
    id: safeEvent.activityId,
    callId: safeEvent.callId,
    ...(safeEvent.taskId !== undefined && { taskId: safeEvent.taskId }),
    phase: safeEvent.phase,
    role: safeEvent.role,
    stage: safeEvent.stage,
    kind: safeEvent.kind,
    label: isSessionActivity ? SESSION_ACTIVITY_LABEL : safeEvent.label,
    ...(!isSessionActivity && safeEvent.target !== undefined && { target: safeEvent.target }),
    ...(safeEvent.runnerName !== undefined && { runnerName: safeEvent.runnerName }),
    ...(safeEvent.model !== undefined && { model: safeEvent.model }),
    redacted: safeEvent.redacted,
    rawAvailable,
    ...(rawAvailable && { expandId: safeEvent.expandId ?? safeEvent.activityId }),
    ...(!isSessionActivity &&
      safeEvent.textPartial !== undefined && { textPartial: safeEvent.textPartial }),
    ...(!isSessionActivity &&
      safeEvent.diagnosticPartial !== undefined && {
        diagnosticPartial: safeEvent.diagnosticPartial,
      }),
    sequence: safeEvent.sequence,
    ts: safeEvent.ts,
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

function safeRunnerActivityEvent(
  event: EngineEventOf<'runner_call_activity'>,
): SafeRunnerActivityEvent | null {
  const label = cleanRequiredActivityText(event.label);
  if (label === null) return null;
  const target = cleanOptionalActivityText(event.target);
  const textPartial = cleanOptionalActivityText(event.textPartial);
  const diagnosticPartial = cleanOptionalActivityText(event.diagnosticPartial);
  const redacted =
    event.redacted ||
    label.changed ||
    target?.changed === true ||
    textPartial?.changed === true ||
    diagnosticPartial?.changed === true;

  return {
    ...event,
    [SAFE_RUNNER_ACTIVITY]: true,
    label: label.text,
    ...(target !== undefined && { target: target.text }),
    ...(textPartial !== undefined && { textPartial: textPartial.text }),
    ...(diagnosticPartial !== undefined && { diagnosticPartial: diagnosticPartial.text }),
    redacted,
  };
}

function cleanRequiredActivityText(
  value: string,
): { readonly text: string; readonly changed: boolean } | null {
  const text = sanitizeTerminalDisplayText(value).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return { text, changed: text !== value };
}

function cleanOptionalActivityText(
  value: string | undefined,
): { readonly text: string; readonly changed: boolean } | undefined {
  if (value === undefined) return undefined;
  const text = sanitizeTerminalDisplayText(value).replace(/\s+/g, ' ').trim();
  return text.length === 0 ? undefined : { text, changed: text !== value };
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
