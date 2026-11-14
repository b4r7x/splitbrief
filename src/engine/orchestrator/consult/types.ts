import type { Config } from '../../../core/schemas/config.js';
import type {
  ConsultAnswer,
  CannotNextStep,
  ConsultReason,
  ImplementerReport,
} from '../../../core/schemas/consult.js';
import type { TriageResult } from '../../../core/schemas/review/verdict.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { SeatProtocolError } from '../../runners/typed-output.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { BaseGate } from '../validation/base-gate.js';
import type { Validator, ValidationCommandRunner } from '../validation/types.js';

export type ConsultApplyContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  validator: Validator;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  /** The state the applied answer runs on; every transition it saves is persisted. */
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  changedFiles?: readonly string[] | undefined;
  /** Where the brief's first attempt started. */
  taskStartSnapshot: ChangedFilesSnapshot;
  runCommand?: ValidationCommandRunner | undefined;
  /** A `verify` red splits by the project gate at the run base. */
  baseGate?: BaseGate | undefined;
  /** Receives the state after each saved transition: the replacement, the inserted tasks. */
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

export type RewriteAction = ConsultAnswer['answer'] & { action: 'rewrite-task' };
export type SplitAction = ConsultAnswer['answer'] & { action: 'split-task' };
export type VerifyAction = ConsultAnswer['answer'] & { action: 'verify' };
export type AskUserAction = ConsultAnswer['answer'] & { action: 'ask-user' };

/** What the answer did, with the task or tasks it left behind. */
export type ConsultApplyOutcome =
  | Readonly<{ action: 'guidance'; instructions: string; context: string | null }>
  | Readonly<{ action: 'rewrite-task'; task: Task }>
  | Readonly<{ action: 'split-task'; tasks: Task[] }>
  | Readonly<{ action: 'completed'; task: Task; durationMs: number; bookedFiles: string[] }>
  | Readonly<{ action: 'correction'; answer: string }>
  | Readonly<{ action: 'failed'; reason: string }>
  | Readonly<{ action: 'unanswered'; question: string }>
  | Readonly<{ action: 'cannot'; reason: string; next: CannotNextStep | null }>
  | Readonly<{ action: 'skipped' }>;

export type ConsultContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  /** With the state's approval, whether a `cmd` check of a rewrite or split may run an npm script. */
  config: Config;
  planner: Pick<Planner, 'capabilities' | 'typedCall'>;
  /** The state the consult runs on; every transition it saves is persisted. */
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  /** Receives the state after each saved transition: a session handle, the record, the count. */
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

export type ConsultRequestInput = Readonly<{
  task: Task;
  reason: ConsultReason;
  failingOutput: string;
  report?: ImplementerReport | null | undefined;
  /**
   * A stuck review's consult: the reviewer's next fix work, which the answer reshapes, the ids of
   * the blockers that did not move, and the red checks and Apply conflicts that block.
   */
  stuck?:
    | Readonly<{
        fixWork: TriageResult;
        blockerIds: readonly string[];
        redInputs: readonly string[];
      }>
    | undefined;
}>;

export type ConsultOutcome =
  | Readonly<{ answer: ConsultAnswer }>
  | Readonly<{ error: SeatProtocolError }>;
