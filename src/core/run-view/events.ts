import type { CrewSeatId } from '../crew/identity.js';
import type { FileAction, RunnerKind, TaskCompletionMethod } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { StepRef } from '../schemas/run-step.js';
import type { CheckResult } from '../schemas/task.js';
import type { SeatWait } from '../schemas/workflow.js';

// The engine events the run view folds, by the fields it reads. `core/` cannot import the engine
// schema; `engine/events/run-view-events.test.ts` checks each engine event is assignable here.

export type SeatWaitStartedEvent = {
  type: 'seat_wait_started';
  seat: CrewSeatId;
  resetAt: string;
  tool?: string | undefined;
  wait?: SeatWait | undefined;
};
export type SeatWaitEndedEvent = {
  type: 'seat_wait_ended';
  seat: CrewSeatId;
  kept?: true | undefined;
};

export type RecoveryPromptedEvent = {
  type: 'recovery_prompted';
  issue?: RecoveryIssue | undefined;
  at?: StepRef | undefined;
};
export type RecoveryResolvedEvent = { type: 'recovery_resolved'; issueId: string };

export type TasksPlannedEvent = {
  type: 'tasks_planned';
  tasks: readonly { id: string; title: string; file: string; action: FileAction }[];
  total: number;
};
export type TaskStartedEvent = {
  type: 'task_started';
  taskId: string;
  title: string;
  total: number;
  lineageAttempt?: number | undefined;
  file: string;
  files?: readonly string[] | undefined;
  action: FileAction;
  tool?: string | undefined;
  model?: string | undefined;
  axes?: readonly string[] | undefined;
  backendKind?: RunnerKind | undefined;
  implementerProfile?: string | undefined;
};
export type WorkflowResumedEvent = { type: 'workflow_resumed' };
export type TaskCompletedEvent = {
  type: 'task_completed';
  taskId: string;
  method: TaskCompletionMethod;
};
export type TaskSkippedEvent = { type: 'task_skipped'; taskId: string };
export type TaskEscalatingEvent = { type: 'task_escalating'; taskId: string };
export type TaskFullFailEvent = { type: 'task_full_fail'; taskId: string };
export type TaskResetEvent = { type: 'task_reset'; taskId: string };
export type TaskRetryEvent = {
  type: 'task_retry';
  attempt: number;
  lineageAttempt?: number | undefined;
};
export type ImplementerGenerateRunningEvent = {
  type: 'implementer_generate_running';
  lineageAttempt?: number | undefined;
};
export type ChecksRunEvent = {
  type: 'checks_run';
  taskId: string;
  results: readonly CheckResult[];
};
export type WorkflowCompleteEvent = {
  type: 'workflow_complete';
  completedTasks?: number | undefined;
};

export type BriefEvent =
  | TasksPlannedEvent
  | TaskStartedEvent
  | WorkflowResumedEvent
  | TaskCompletedEvent
  | TaskSkippedEvent
  | TaskEscalatingEvent
  | TaskFullFailEvent
  | TaskResetEvent
  | TaskRetryEvent
  | ImplementerGenerateRunningEvent
  | ChecksRunEvent
  | WorkflowCompleteEvent;
