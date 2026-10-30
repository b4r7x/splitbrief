import { expectTypeOf, it } from 'vitest';
import type {
  ChecksRunEvent,
  ImplementerGenerateRunningEvent,
  RecoveryPromptedEvent,
  RecoveryResolvedEvent,
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
