import { isProcessWentAwayMark } from '../../../core/event-phase.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
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
  kind: Exclude<ActivityEvent['kind'], 'session'>;
  label: string;
  target?: string;
  since: number;
}

interface OperationBase {
  reviewStep?: EngineEventOf<'review_step'>['step'] | undefined;
  /** The call asks the seat again: its first answer did not match the contract. */
  answeringAgain?: true;
  callId: string;
  role: OperationRole;
  backendKind?: EngineEventOf<'runner_call_started'>['backendKind'];
  phase: Phase;
  taskId?: string;
  label: string;
  runnerName?: string;
  model?: string;
  axes?: readonly string[];
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

/**
 * The command or render the run is inside: a plan or reviewer check (`id`) or, in a session from
 * before the reviewer chose them, a full-suite stage (`stage`).
 */
export interface RunningSuiteStage {
  id?: string | undefined;
  stage?: NonNullable<ValidationStage> | undefined;
  command: string;
  moment: EngineEventOf<'full_suite'>['moment'];
  scenario?: string | undefined;
  /** A red reviewer check waits on the run of the same id at the run base. */
  waitsOnBase?: true | undefined;
  stageStartedTs: number;
}

/**
 * One command's identity across its running and settled events: the moment it runs at, and its
 * check id, else its stage. A reviewer check and its re-run at the run base share an id, so the
 * moment keeps them two commands.
 */
export function suiteCommandKey(suite: Pick<RunningSuiteStage, 'id' | 'stage' | 'moment'>): string {
  return `${suite.moment}:${suite.id ?? suite.stage}`;
}

export interface OperationsState {
  active: ActiveOperation | null;
  last: ActiveOperation | null;
  byCallId: Map<string, ActiveOperation>;
  /** Optional so the retention helpers can keep their narrow shape; the reducer always sets it. */
  validationStage?: RunningValidationStage | null;
  suiteStage?: RunningSuiteStage | null;
  /**
   * The project gate command running at the run base. It runs beside the build and the checks, so
   * it has its own slot: a steer, a cut seat call and a continue in the same process do not clear
   * it. Its own events clear it, and so do a stop or an end, a replay whose process went away and
   * the run loop of a new process.
   */
  baseStage?: RunningSuiteStage | null;
  reviewStage?: RunningOperation | null;
  /** The reviewer's answer was refused: its next call asks it again. */
  reviewerAnswerRefused?: boolean;
  /**
   * A task review is due inside the build phase: the engine's `pendingScheduledReview`, from the
   * review's start until BUILD starts a brief or the review's fix cycle starts. A halt, a stop or
   * a question inside it keeps it.
   */
  scheduledReview?: boolean;
}

/**
 * The command the run is inside: the running check, or, while a reviewer check waits on the same
 * command's run at the run base, that base command.
 */
export function selectRunningSuite(
  state: Pick<OperationsState, 'suiteStage' | 'baseStage'>,
): RunningSuiteStage | null {
  const suite = state.suiteStage ?? null;
  const base = state.baseStage ?? null;
  return base !== null && suite?.waitsOnBase === true && suite.id === base.id ? base : suite;
}

/**
 * A base command runs beside the build, so a steer, a cut seat call and a continue in the same
 * process leave it running; a stop or an end, the run loop of a new process and a process that
 * went away end it.
 */
export function endsBaseCommand(event: EngineEvent): boolean {
  return (
    isProcessWentAwayMark(event) ||
    event.type === 'workflow_cancelled' ||
    (event.type === 'workflow_resumed' && event.inProcess !== true)
  );
}

/** REVIEW reads what is typed: a task review is due inside the build phase. */
export function selectScheduledReview(state: OperationsState): boolean {
  return state.scheduledReview === true;
}

const initial = (): OperationsState => ({
  active: null,
  last: null,
  byCallId: new Map(),
  validationStage: null,
  suiteStage: null,
  baseStage: null,
  reviewStage: null,
  scheduledReview: false,
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
