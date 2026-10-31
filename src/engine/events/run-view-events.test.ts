import { expectTypeOf, it } from 'vitest';
import type {
  ChecksRunEvent,
  ImplementerGenerateRunningEvent,
  PlannerQuestionsAskedEvent,
  RecoveryPromptedEvent,
  RecoveryResolvedEvent,
  RunFailedEvent,
  RunRejectedEvent,
  SeatWaitEndedEvent,
  SeatWaitStartedEvent,
  TaskCompletedEvent,
  TaskEscalatingEvent,
  TaskFullFailEvent,
  TaskResetEvent,
  TaskRetryEvent,
  TaskSkippedEvent,
  TaskStartedEvent,
  TasksPlannedEvent,
  TurnInterruptedEvent,
  WorkflowCompleteEvent,
  WorkflowResumedEvent,
} from '../../core/run-view/events.js';
import type { EngineEventOf } from './types.js';

it('gives the run view every field it folds from each engine event', () => {
  expectTypeOf<EngineEventOf<'seat_wait_started'>>().toExtend<SeatWaitStartedEvent>();
  expectTypeOf<EngineEventOf<'seat_wait_ended'>>().toExtend<SeatWaitEndedEvent>();
  expectTypeOf<EngineEventOf<'tasks_planned'>>().toExtend<TasksPlannedEvent>();
  expectTypeOf<EngineEventOf<'task_started'>>().toExtend<TaskStartedEvent>();
  expectTypeOf<EngineEventOf<'workflow_resumed'>>().toExtend<WorkflowResumedEvent>();
  expectTypeOf<EngineEventOf<'task_completed'>>().toExtend<TaskCompletedEvent>();
  expectTypeOf<EngineEventOf<'task_skipped'>>().toExtend<TaskSkippedEvent>();
  expectTypeOf<EngineEventOf<'task_escalating'>>().toExtend<TaskEscalatingEvent>();
  expectTypeOf<EngineEventOf<'task_full_fail'>>().toExtend<TaskFullFailEvent>();
  expectTypeOf<EngineEventOf<'task_reset'>>().toExtend<TaskResetEvent>();
  expectTypeOf<EngineEventOf<'task_retry'>>().toExtend<TaskRetryEvent>();
  expectTypeOf<
    EngineEventOf<'implementer_generate_running'>
  >().toExtend<ImplementerGenerateRunningEvent>();
  expectTypeOf<EngineEventOf<'checks_run'>>().toExtend<ChecksRunEvent>();
  expectTypeOf<EngineEventOf<'workflow_complete'>>().toExtend<WorkflowCompleteEvent>();
});

it('gives the run view every field it folds from the halt events', () => {
  expectTypeOf<EngineEventOf<'recovery_prompted'>>().toExtend<RecoveryPromptedEvent>();
  expectTypeOf<EngineEventOf<'recovery_resolved'>>().toExtend<RecoveryResolvedEvent>();
});

it('gives the run view every field it folds from the ask and stop events', () => {
  expectTypeOf<EngineEventOf<'planner_questions_asked'>>().toExtend<PlannerQuestionsAskedEvent>();
  expectTypeOf<EngineEventOf<'turn_interrupted'>>().toExtend<TurnInterruptedEvent>();
  expectTypeOf<EngineEventOf<'run_failed'>>().toExtend<RunFailedEvent>();
  expectTypeOf<EngineEventOf<'run_rejected'>>().toExtend<RunRejectedEvent>();
});
