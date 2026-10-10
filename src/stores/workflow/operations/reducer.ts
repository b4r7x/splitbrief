import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import {
  cancelRunningOperations,
  operationStatusFromFailure,
  replaceOperation,
  startRunnerOperation,
  terminalizeKnownOperation,
  updateKnownOperation,
} from './runner.js';
import { closeStatusFallbacks, updateStatusFallback } from './planner-status.js';
import {
  suiteCommandKey,
  type OpenTool,
  type OperationsState,
  type RunningSuiteStage,
  type RunningValidationStage,
} from './state.js';
import { appendWarning, showsWarningOnPrimarySurface } from './warnings.js';

type ValidationEvent = Extract<EngineEvent, { type: 'validate' }>;
type SuiteEvent = Extract<EngineEvent, { type: 'full_suite' }>;

function runningValidationStage(event: ValidationEvent): RunningValidationStage | null {
  if (event.status !== 'running' || event.activeStage === undefined) return null;
  const stage = event.activeStage;
  return {
    stage,
    command: event.commands?.[stage] ?? null,
    stageStartedTs: event.ts,
  };
}

function applyValidationStage(state: OperationsState, event: ValidationEvent): OperationsState {
  const next = runningValidationStage(event);
  // A stage that is still the same stage keeps the clock it started on: the block reports how long
  // this command has been running, not how long since its last progress event.
  const current = state.validationStage ?? null;
  if (next !== null && current?.stage === next.stage) return state;
  if (next === null && current === null) return state;
  return { ...state, validationStage: next };
}

function runningSuiteStage(event: SuiteEvent): RunningSuiteStage | null {
  if (event.status !== 'running') return null;
  return {
    ...(event.id !== undefined && { id: event.id }),
    ...(event.stage !== undefined && { stage: event.stage }),
    command: event.command,
    moment: event.moment,
    ...(event.scenario !== undefined && { scenario: event.scenario }),
    stageStartedTs: event.ts,
  };
}

function applySuiteStage(state: OperationsState, event: SuiteEvent): OperationsState {
  const next = runningSuiteStage(event);
  const current = state.suiteStage ?? null;
  if (next !== null && current !== null && suiteCommandKey(current) === suiteCommandKey(next)) {
    return state;
  }
  if (next === null && current === null) return state;
  return { ...state, suiteStage: next };
}

// A stopped command publishes no settled event, so the stop ends its stage: a resume that runs the
// same stage again starts a new clock.
function cancelOperations(
  state: OperationsState,
  cancellation: { ts: number; reason: string },
): OperationsState {
  const stageRunning =
    (state.validationStage ?? null) !== null || (state.suiteStage ?? null) !== null;
  const settled =
    stageRunning || state.reviewStage != null
      ? { ...state, validationStage: null, suiteStage: null, reviewStage: null }
      : state;
  return cancelRunningOperations(settled, cancellation);
}

function restoreReviewFallback(state: OperationsState): OperationsState {
  const review = state.reviewStage ?? null;
  return state.active === null && review !== null ? replaceOperation(state, review) : state;
}

// Activity that is not a tool the seat runs: it never opens, so it never holds a silence open.
const NOT_A_TOOL: ReadonlySet<EngineEventOf<'runner_call_activity'>['kind']> = new Set([
  'text',
  'artifact',
  'warning',
  'error',
]);

// A tool stays open from its first started or updated activity until any other stage of the same
// activity closes it; the time it opened is the first one, however many updates follow.
function nextOpenTools(
  open: readonly OpenTool[],
  event: EngineEventOf<'runner_call_activity'> & { kind: OpenTool['kind'] },
): readonly OpenTool[] {
  const opened = open.find((tool) => tool.activityId === event.activityId);
  const rest = open.filter((tool) => tool.activityId !== event.activityId);
  if (event.stage !== 'started' && event.stage !== 'updated') return rest;
  return [
    ...rest,
    {
      activityId: event.activityId,
      kind: event.kind,
      label: event.label,
      ...(event.target !== undefined && { target: event.target }),
      since: opened?.since ?? event.ts,
    },
  ];
}

export function updateOperations(state: OperationsState, event: EngineEvent): OperationsState {
  switch (event.type) {
    case 'validate':
      return applyValidationStage(state, event);
    case 'full_suite':
      return applySuiteStage(state, event);
    case 'runner_call_started':
      return startRunnerOperation(closeStatusFallbacks(state, event.ts), event);
    case 'runner_call_runtime_status':
      return updateKnownOperation(state, event.callId, (operation) =>
        operation.status === 'running' && operation.apiRuntimeStatus?.phase !== 'finished'
          ? { ...operation, apiRuntimeStatus: event.runtimeStatus }
          : operation,
      );
    case 'runner_call_activity': {
      const kind = event.kind;
      if (kind === 'session' || NOT_A_TOOL.has(kind)) return state;
      return updateKnownOperation(state, event.callId, (operation) =>
        operation.status === 'running'
          ? {
              ...operation,
              openTools: nextOpenTools(operation.openTools ?? [], { ...event, kind }),
            }
          : operation,
      );
    }
    case 'runner_call_usage':
      return updateKnownOperation(state, event.callId, (operation) => ({
        ...operation,
        usage: event.usage,
      }));
    case 'runner_call_warning':
      return updateKnownOperation(state, event.callId, (operation) =>
        operation.status === 'running' && showsWarningOnPrimarySurface(event.warning)
          ? { ...operation, warnings: appendWarning(operation.warnings, event.warning, event.ts) }
          : operation,
      );
    case 'runner_call_completed':
      return restoreReviewFallback(
        terminalizeKnownOperation(state, event.callId, {
          status: 'completed',
          endedAt: event.endedAt,
          durationMs: event.durationMs,
          reason: null,
          usage: event.usage,
          partial: false,
        }),
      );
    case 'runner_call_error':
      return restoreReviewFallback(
        terminalizeKnownOperation(state, event.callId, {
          status: operationStatusFromFailure(event.status),
          endedAt: event.endedAt,
          durationMs: event.durationMs,
          reason: event.error.message,
          usage: event.usage,
          partial: event.partial,
        }),
      );
    case 'workflow_cancelled':
    case 'turn_interrupted':
    case 'workflow_resumed':
      return cancelOperations(state, {
        ts: event.ts,
        reason: event.type === 'workflow_cancelled' ? (event.reason ?? event.type) : event.type,
      });
    case 'planner_status':
    case 'review_started':
    case 'review_completed':
      return updateStatusFallback(state, event);
    default:
      return state;
  }
}

export function markOperationsCancellationRequested(
  state: OperationsState,
  cancellation: { ts: number; reason: string },
): OperationsState {
  return cancelOperations(state, cancellation);
}
