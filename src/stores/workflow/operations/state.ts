import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { createStore, storeBase } from '../../create-store.js';

type RunnerCallFailureStatus = EngineEventOf<'runner_call_error'>['status'];

export type OperationStatus = 'running' | 'completed' | 'cancelled' | RunnerCallFailureStatus;

export type TerminalOperationStatus = Exclude<OperationStatus, 'running'>;

export type OperationRole = EngineEventOf<'runner_call_started'>['role'];
export type OperationWarningSeverity = EngineEventOf<'runner_call_warning'>['warning']['severity'];

export interface OperationWarningGroup {
  code: string;
  severity: OperationWarningSeverity;
  source: string;
  surface: EngineEventOf<'runner_call_warning'>['warning']['surface'];
  fingerprint: string;
  count: number;
  firstTs: number;
  lastTs: number;
  latestMessage: string;
}

type ActivityEvent = EngineEventOf<'runner_call_activity'>;

/** A tool the call's stream opened and has not closed yet, and when it opened. */
export interface OpenTool {
  activityId: string;
  kind: ActivityEvent['kind'];
  label: string;
  target?: string;
  since: number;
}

interface OperationBase {
  callId: string;
  role: OperationRole;
  backendKind?: EngineEventOf<'runner_call_started'>['backendKind'];
  phase: Phase;
  taskId?: string;
  label: string;
  runnerName?: string;
  model?: string;
  attempt?: number;
  startedAt: number;
  reason: string | null;
  usage: unknown | null;
  warnings: readonly OperationWarningGroup[];
  apiRuntimeStatus?: EngineEventOf<'runner_call_runtime_status'>['runtimeStatus'];
  openTools?: readonly OpenTool[];
}

export interface RunningOperation extends OperationBase {
  status: 'running';
  endedAt: null;
  durationMs: null;
  partial: false;
  reason: null;
}

export interface TerminalOperation extends OperationBase {
  status: TerminalOperationStatus;
  endedAt: number;
  durationMs: number;
  partial: boolean;
}

export type ActiveOperation = RunningOperation | TerminalOperation;

export type ValidationStage = EngineEventOf<'validate'>['activeStage'];

/** The gate command the run is inside right now, and when it started producing nothing. */
export interface RunningValidationStage {
  stage: NonNullable<ValidationStage>;
  command: string | null;
  stageStartedTs: number;
}

/** The full-suite stage the run is inside right now, and the moment of the run it runs at. */
export interface RunningSuiteStage extends RunningValidationStage {
  command: string;
  moment: EngineEventOf<'full_suite'>['moment'];
}

export interface OperationsState {
  active: ActiveOperation | null;
  last: ActiveOperation | null;
  byCallId: Map<string, ActiveOperation>;
  /** Optional so the retention helpers can keep their narrow shape; the reducer always sets it. */
  validationStage?: RunningValidationStage | null;
  suiteStage?: RunningSuiteStage | null;
}

const initial = (): OperationsState => ({
  active: null,
  last: null,
  byCallId: new Map(),
  validationStage: null,
  suiteStage: null,
});

const store = createStore<OperationsState>(initial);

function __testReset(next?: Partial<OperationsState>): void {
  store.set(next ? { ...initial(), ...next } : initial());
}

export const _operationsInternal = { set: store.set };

export const operationsStore = {
  ...storeBase(store),
  __testReset,
};
