import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer } from '../../implementers/types.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import type { ChangeDetectionKind } from '../../change-detection.js';
import type { WorkflowContext, WorkflowPersistenceContext } from '../types.js';
import type { UsageCategory } from '../tokens.js';
import type { IsolationRole } from '../isolation/types.js';
import type { ValidationResult } from '../validation/result.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { HAND_BACK_MAX_CHARS } from '../../../core/pipeline-spec/ladder.js';

export type RetryFailureDetail = Readonly<{
  /** The error the last attempt failed on, not the run's first validation failure. */
  lastError?: string | undefined;
  /** Bounded tail of the last failing attempt's own account of its stop. */
  handBack?: string | undefined;
}>;

export type RetryResult =
  | {
      completed: true;
      method: Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;
      attempts: number;
      acceptance: ValidationAcceptance;
      /** The brief's duration its completion event published. */
      durationMs: number;
      validationResults?: ValidationResult[] | undefined;
      changedFiles?: string[] | undefined;
      tool?: string | undefined;
      model?: string | undefined;
    }
  | ({ completed: false; method: 'failed'; attempts: number } & RetryFailureDetail);

export function failedRetry(attempts: number, detail?: RetryFailureDetail): RetryResult {
  return {
    completed: false,
    method: 'failed',
    attempts,
    ...(detail?.lastError !== undefined && { lastError: detail.lastError }),
    ...(detail?.handBack !== undefined && { handBack: detail.handBack }),
  };
}

/** Bounded tail of an implementer's own account of its stop; undefined when it printed none. */
export function boundedHandBack(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= HAND_BACK_MAX_CHARS
    ? trimmed
    : trimmed.slice(trimmed.length - HAND_BACK_MAX_CHARS);
}

export type EscalationContext = WorkflowContext & {
  taskStartTime: number;
  taskStartSnapshot: ChangedFilesSnapshot;
  dependsOnFiles: string[];
};

/** Machine outcome of the attempt that produced `lastError`, with the runner that made it. */
export type RetryAttemptFailure = {
  outcome: RunnerFailureOutcomeState;
  runner: Config['implementer'];
  /** Bounded tail of the failing attempt's final text; absent when the tool printed none. */
  handBack?: string | undefined;
};

export type RetryStepOutcome = {
  state: WorkflowState;
  task: Task;
  lastError: string;
  /** The failing stage and the line of its output that names the failure; absent when no validation ran. */
  diagnosis?: string | undefined;
  attempts: number;
  result?: RetryResult;
  lastFailure?: RetryAttemptFailure | undefined;
  /** This attempt's start snapshot: the rollback baseline a consult applies against. */
  attemptSnapshot?: ChangedFilesSnapshot | undefined;
};

export type SuccessMethod = Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;

/** Where the seat-trouble wrapper parks a wait: the live state and the seat's call site. */
export type RetrySeatTarget = Readonly<{
  ref: WorkflowPersistenceContext;
  state: WorkflowState;
  /** The usage category the tokens of a discarded attempt are recorded under. */
  usageCategory: UsageCategory;
}>;

export type RetryInvokeArgs = {
  task: Task;
  lastError: string;
  attempts: number;
  projectDir: string;
  config: Config;
  implementer: Implementer;
  implementerProfile?: string | undefined;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
  fileIgnoreProjectDir?: string | undefined;
  /** Baseline the acquired workspace declares; sniffed from the directory when absent. */
  changeDetection?: ChangeDetectionKind | undefined;
  createdByThisTask?: readonly string[] | undefined;
  /** The seat-trouble wrapper's target; the step supplies the live state and usage category. */
  seat: RetrySeatTarget;
};

export type RetryInvokeResult = {
  success: boolean;
  error?: string | undefined;
  /** The runner's final text, carried through from `ImplementerResult.output`. */
  output?: string | undefined;
  outcome?: RunnerFailureOutcomeState | undefined;
  usage?: TokenDelta | null | undefined;
  applyResult?: BundleApplyResult | undefined;
  /** The runner config the invocation actually used; absent when it matches the step's config. */
  runner?: Config['implementer'] | undefined;
};

export type RetryStepOpts = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  attempts: number;
  method: SuccessMethod;
  transitionType: 'VALIDATION_PASS';
  commitSuffix?: string | undefined;
  usageCategory: UsageCategory;
  retryFailureFallback: string;
  profileOverride?: string | undefined;
  isolationRole?: IsolationRole | undefined;
  resultTool?: string | undefined;
  resultModel?: string | undefined;
  invokeRetry: (args: RetryInvokeArgs) => Promise<RetryInvokeResult>;
  onValidationAfterRetryFail?: ((validationError: string) => void) | undefined;
};
