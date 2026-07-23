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

interface OperationBase {
  callId: string;
  role: OperationRole;
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

export interface OperationsState {
  active: ActiveOperation | null;
  last: ActiveOperation | null;
  byCallId: Map<string, ActiveOperation>;
}

const initial = (): OperationsState => ({
  active: null,
  last: null,
  byCallId: new Map(),
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
