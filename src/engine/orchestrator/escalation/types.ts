import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer } from '../../implementers/types.js';
import type { ChangeDetectionKind } from '../../change-detection.js';
import type { WorkflowContext } from '../types.js';
import type { UsageCategory } from '../tokens.js';
import type { IsolationRole } from '../isolation/types.js';
import type { ValidationResult } from '../validation/result.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';

export const MAX_HINT_ERROR_LENGTH = 4000;

export type RetryResult =
  | {
      completed: true;
      method: Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;
      attempts: number;
      acceptance: ValidationAcceptance;
      validationResults?: ValidationResult[] | undefined;
      changedFiles?: string[] | undefined;
      tool?: string | undefined;
      model?: string | undefined;
    }
  | { completed: false; method: 'failed'; attempts: number };

export function failedRetry(attempts: number): RetryResult {
  return { completed: false, method: 'failed', attempts };
}

export type EscalationContext = WorkflowContext & {
  taskStartTime?: number | undefined;
  taskStartSnapshot: ChangedFilesSnapshot;
  dependsOnFiles: string[];
};

export type RetryStepOutcome = {
  state: WorkflowState;
  task: Task;
  lastError: string;
  attempts: number;
  result?: RetryResult;
};

export type SuccessMethod = Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;

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
};

export type TierStepInput = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  priorAttempts: number;
};

export type RetryStepOpts = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  attempts: number;
  method: SuccessMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  usageCategory: UsageCategory;
  retryFailureFallback: string;
  profileOverride?: string | undefined;
  isolationRole?: IsolationRole | undefined;
  resultTool?: string | undefined;
  resultModel?: string | undefined;
  invokeRetry: (args: RetryInvokeArgs) => Promise<{
    success: boolean;
    error?: string | undefined;
    usage?: TokenDelta | null | undefined;
  }>;
  onValidationAfterRetryFail?: ((validationError: string) => void) | undefined;
};
