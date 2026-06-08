import { z } from 'zod';
import {
  ActionClassSchema,
  ApproveLevelSchema,
  CurrentCodeContextModeSchema,
  FileActionSchema,
  type Phase,
  PhaseSchema,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  TaskCompletionMethodSchema,
  TaskContextFitSchema,
  TaskStatusSchema,
  UserEditConflictActionSchema,
  UserEditConflictKindSchema,
  WorkflowModeSchema,
} from '../../core/schemas/enums.js';
import { ApprovalTierSchema } from '../../core/schemas/config.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { CostPredictionSchema } from '../../core/schemas/summary.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from '../../core/schemas/tokens.js';
import type { EngineEvent } from './types.js';
import { TASK_REVIEW_COMMANDS } from './workflow-events.js';

const stringArray = z.array(z.string());
const taskIdArray = z.array(TaskIdSchema);

function phaseEvent<T extends string>(type: T) {
  return z.object({
    type: z.literal(type),
    ts: z.number(),
    phase: PhaseSchema,
  });
}

function noPhaseEvent<T extends string>(type: T) {
  return z.object({
    type: z.literal(type),
    ts: z.number(),
  });
}

const validationStagesSchema = z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  test: z.boolean(),
});

export const userEditConflictSchema = z
  .object({
    kind: UserEditConflictKindSchema,
    files: stringArray,
    affectedTaskIds: taskIdArray,
    currentTaskId: TaskIdSchema.optional(),
    fileConflicts: z.array(
      z
        .object({
          file: z.string(),
          kind: UserEditConflictKindSchema,
          affectedTaskIds: taskIdArray,
        })
        .passthrough(),
    ),
    safeToContinue: z.boolean(),
    availableActions: z.array(UserEditConflictActionSchema),
  })
  .passthrough();

export const taskReviewRequestFields = {
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  status: z.union([TaskStatusSchema, z.literal('recovery-required')]),
  filesTouched: stringArray,
  validation: z
    .object({
      passed: z.boolean().nullable(),
      summary: z.string(),
      stages: z.array(
        z
          .object({
            stage: z.string(),
            passed: z.boolean(),
            errorSummary: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  evidence: z
    .object({
      path: z.string().optional(),
      summary: z.string(),
      expected: stringArray,
      observed: stringArray,
    })
    .passthrough(),
  cost: z
    .object({
      tokenUsage: TokenUsageSchema,
      taskTokens: TaskTokenUsageSchema.optional(),
      tool: z.string().optional(),
      model: z.string().optional(),
      implementerProfile: z.string().optional(),
    })
    .passthrough(),
  routing: z
    .object({
      selectedProfile: z.string().optional(),
      fit: TaskContextFitSchema,
      estimatedTokens: z.number(),
      untruncatedEstimatedTokens: z.number(),
      contextLength: z.number().optional(),
      currentCodeTruncated: z.boolean(),
      currentCodeContextMode: CurrentCodeContextModeSchema,
      costPosture: z.string(),
      reason: z.string(),
    })
    .passthrough()
    .optional(),
  recovery: z
    .object({
      reason: RecoveryReasonSchema,
      message: z.string(),
      availableActions: stringArray,
      recommendedAction: z.string(),
    })
    .passthrough()
    .optional(),
  availableCommands: z.array(z.enum(TASK_REVIEW_COMMANDS)),
} as const;

export const EngineEventSchema = z.discriminatedUnion('type', [
  phaseEvent('workflow_started').extend({ feature: z.string() }).passthrough(),
  phaseEvent('workflow_resumed').passthrough(),
  phaseEvent('workflow_complete').passthrough(),
  phaseEvent('workflow_cancelled').passthrough(),
  phaseEvent('workflow_config')
    .extend({
      mode: WorkflowModeSchema,
      plannerTool: z.string(),
      plannerModel: z.string().optional(),
      implementerTool: z.string(),
      implementerModel: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('paused_external_changes')
    .extend({
      conflict: userEditConflictSchema.optional(),
      selectedAction: UserEditConflictActionSchema.optional(),
    })
    .passthrough(),
  phaseEvent('recovery_prompted')
    .extend({
      issueId: z.string(),
      reason: RecoveryReasonSchema,
      taskId: TaskIdSchema.optional(),
      files: stringArray,
      affectedTaskIds: taskIdArray,
      availableActions: z.array(RecoveryActionSchema),
      recommendedAction: RecoveryActionSchema,
    })
    .passthrough(),
  phaseEvent('recovery_action_selected')
    .extend({
      issueId: z.string(),
      reason: RecoveryReasonSchema,
      action: RecoveryActionSchema,
    })
    .passthrough(),
  phaseEvent('recovery_action_failed')
    .extend({
      issueId: z.string(),
      reason: RecoveryReasonSchema,
      action: RecoveryActionSchema,
      message: z.string(),
    })
    .passthrough(),
  phaseEvent('recovery_resolved')
    .extend({
      issueId: z.string(),
      reason: RecoveryReasonSchema,
      action: RecoveryActionSchema,
      outcome: z.enum(['continued', 'retry-current-task', 'skipped-current-task', 'aborted']),
      implementerProfile: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('planner_status')
    .extend({
      status: z.enum(['running', 'done']),
      tool: z.string().optional(),
      model: z.string().optional(),
      duration: z.number().optional(),
      summary: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('planner_text').extend({ text: z.string() }).passthrough(),
  phaseEvent('planner_heartbeat')
    .extend({
      elapsedMs: z.number(),
      accumulatedTokens: z.number(),
      phaseHint: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('spec_rejected').passthrough(),
  phaseEvent('spec_regenerated').extend({ comment: z.string() }).passthrough(),
  phaseEvent('plan_approved').passthrough(),
  phaseEvent('plan_rejected').passthrough(),
  phaseEvent('plan_regenerated').extend({ comment: z.string() }).passthrough(),
  phaseEvent('rewind_to_spec').extend({ comment: z.string().optional() }).passthrough(),
  phaseEvent('rewind_to_plan').extend({ comment: z.string().optional() }).passthrough(),
  phaseEvent('all_tasks_done').passthrough(),
  phaseEvent('brief_quality_passed')
    .extend({
      score: z.number(),
      warningCount: z.number(),
    })
    .passthrough(),
  phaseEvent('brief_quality_failed')
    .extend({
      score: z.number(),
      errorCount: z.number(),
      warningCount: z.number(),
    })
    .passthrough(),
  phaseEvent('drift_report')
    .extend({
      passed: z.boolean(),
      score: z.number(),
      errorCount: z.number(),
      warningCount: z.number(),
    })
    .passthrough(),
  phaseEvent('drift_chain_detected')
    .extend({
      chainLength: z.number(),
      score: z.number(),
      threshold: z.number(),
      uniqueOutOfBoundsFiles: stringArray,
      representativePath: z.string(),
    })
    .passthrough(),
  phaseEvent('snapshot_created')
    .extend({
      snapshotId: z.string(),
      name: z.string().optional(),
      fileCount: z.number(),
      taskIndex: z.number().optional(),
    })
    .passthrough(),
  noPhaseEvent('snapshot_restored')
    .extend({
      snapshotId: z.string(),
      restoredCount: z.number(),
      conflictedCount: z.number(),
      forcedCount: z.number(),
      forced: z.boolean(),
    })
    .passthrough(),
  noPhaseEvent('snapshot_restore_conflict')
    .extend({
      snapshotId: z.string(),
      conflictedPaths: stringArray,
    })
    .passthrough(),
  phaseEvent('mode_resolved')
    .extend({
      mode: WorkflowModeSchema,
      approve: ApproveLevelSchema,
    })
    .passthrough(),
  phaseEvent('mode_downgrade_advised')
    .extend({
      currentMode: WorkflowModeSchema,
      suggestedMode: WorkflowModeSchema,
    })
    .passthrough(),
  phaseEvent('mode_advice')
    .extend({
      kind: z.enum(['none', 'downgrade', 'upgrade', 'missing-context']),
      risk: z.enum(['trivial', 'small', 'normal', 'high']),
      currentMode: WorkflowModeSchema,
      suggestedMode: WorkflowModeSchema,
      confidence: z.number(),
      factors: stringArray,
      missing: stringArray,
    })
    .passthrough(),
  phaseEvent('instant_plan_received').extend({ taskCount: z.number() }).passthrough(),
  phaseEvent('task_started')
    .extend({
      taskId: TaskIdSchema,
      title: z.string(),
      index: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      file: z.string(),
      action: FileActionSchema,
      tool: z.string().optional(),
      model: z.string().optional(),
      implementerProfile: z.string().optional(),
      contextFit: TaskContextFitSchema.optional(),
      estimatedTokens: z.number().optional(),
      untruncatedEstimatedTokens: z.number().optional(),
      contextLength: z.number().optional(),
      currentCodeTruncated: z.boolean().optional(),
      currentCodeContextMode: CurrentCodeContextModeSchema.optional(),
      costPosture: z.string().optional(),
      routingReason: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('task_completed')
    .extend({
      taskId: TaskIdSchema,
      title: z.string(),
      method: TaskCompletionMethodSchema,
      retries: z.number().int().nonnegative(),
      duration: z.number().int().nonnegative(),
      tool: z.string().optional(),
      model: z.string().optional(),
      implementerProfile: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('task_skipped')
    .extend({
      taskId: TaskIdSchema,
      title: z.string(),
      reason: z.string(),
    })
    .passthrough(),
  phaseEvent('task_retry')
    .extend({
      taskId: TaskIdSchema,
      attempt: z.number().int().nonnegative(),
      maxRetries: z.number().int().nonnegative(),
      error: z.string(),
    })
    .passthrough(),
  phaseEvent('task_escalating').extend({ taskId: TaskIdSchema }).passthrough(),
  phaseEvent('task_full_fail').extend({ taskId: TaskIdSchema }).passthrough(),
  phaseEvent('task_reset').extend({ taskId: TaskIdSchema }).passthrough(),
  phaseEvent('task_tokens')
    .extend({
      taskId: TaskIdSchema,
      method: TaskCompletionMethodSchema,
      implementerTokens: z.number().int().nonnegative(),
      escalationTokens: z.number().int().nonnegative(),
      retryCount: z.number().int().nonnegative(),
      tool: z.string().optional(),
      model: z.string().optional(),
      implementerProfile: z.string().optional(),
      contextFit: TaskContextFitSchema.optional(),
      estimatedTokens: z.number().optional(),
      untruncatedEstimatedTokens: z.number().optional(),
      contextLength: z.number().optional(),
      currentCodeTruncated: z.boolean().optional(),
      currentCodeContextMode: CurrentCodeContextModeSchema.optional(),
      costPosture: z.string().optional(),
      routingReason: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('task_review_needed').extend(taskReviewRequestFields).passthrough(),
  phaseEvent('hint_failed').extend({ taskId: TaskIdSchema }).passthrough(),
  phaseEvent('implementer_generate_running')
    .extend({
      taskId: TaskIdSchema,
      file: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('implementer_generate_done')
    .extend({
      taskId: TaskIdSchema,
      file: z.string(),
      diff: z.string().optional(),
      linesAdded: z.number(),
      linesRemoved: z.number(),
      duration: z.number(),
    })
    .passthrough(),
  phaseEvent('implementer_generate_failed')
    .extend({
      taskId: TaskIdSchema,
      model: z.string(),
    })
    .passthrough(),
  phaseEvent('validate')
    .extend({
      taskId: TaskIdSchema,
      status: z.enum(['running', 'done']),
      passed: z.boolean(),
      stages: validationStagesSchema,
      error: z.string().optional(),
      duration: z.number().optional(),
    })
    .passthrough(),
  phaseEvent('escalate')
    .extend({
      taskId: TaskIdSchema,
      tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      hint: z.string().optional(),
      tool: z.string().optional(),
      model: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('git_commit')
    .extend({
      taskId: TaskIdSchema,
      message: z.string(),
      file: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('git_checkpoint')
    .extend({
      taskId: TaskIdSchema,
      tag: z.string(),
    })
    .passthrough(),
  phaseEvent('git_branch_created').extend({ name: z.string() }).passthrough(),
  phaseEvent('clarifications_collected')
    .extend({
      count: z.number(),
      clarifications: z.array(
        z
          .object({
            question: z.string(),
            answer: z.string(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  phaseEvent('clarification_answered')
    .extend({
      questionId: z.string().optional(),
      answer: z.string(),
    })
    .passthrough(),
  phaseEvent('message_queued').extend({ id: z.string() }).passthrough(),
  phaseEvent('message_injected_native').extend({ id: z.string() }).passthrough(),
  phaseEvent('queue_drained').extend({ count: z.number().int().nonnegative() }).passthrough(),
  phaseEvent('queue_cleared').extend({ count: z.number().int().nonnegative() }).passthrough(),
  phaseEvent('user_message').extend({ text: z.string() }).passthrough(),
  phaseEvent('planner_attachments_dropped')
    .extend({
      count: z.number(),
      reason: z.enum(['unsupported-backend', 'capability-degraded']),
    })
    .passthrough(),
  phaseEvent('cost_update').extend({ tokenUsage: TokenUsageSchema }).passthrough(),
  phaseEvent('cost_prediction').extend({ prediction: CostPredictionSchema }).passthrough(),
  phaseEvent('budget_warning')
    .extend({
      currentCost: z.number(),
      maxBudget: z.number(),
    })
    .passthrough(),
  phaseEvent('budget_paused')
    .extend({
      currentCost: z.number(),
      maxBudget: z.number(),
      threshold: z.number(),
    })
    .passthrough(),
  phaseEvent('budget_exceeded')
    .extend({
      currentCost: z.number(),
      maxBudget: z.number(),
    })
    .passthrough(),
  phaseEvent('approval_prompted')
    .extend({
      tier: ApprovalTierSchema,
      actionClass: ActionClassSchema,
      taskId: TaskIdSchema.optional(),
    })
    .passthrough(),
  phaseEvent('approval_granted')
    .extend({
      tier: ApprovalTierSchema,
      actionClass: ActionClassSchema,
      taskId: TaskIdSchema.optional(),
      scope: z.enum(['once', 'session', 'always']),
      confirmReason: z.string().optional(),
    })
    .passthrough(),
  phaseEvent('approval_rejected')
    .extend({
      tier: ApprovalTierSchema,
      actionClass: ActionClassSchema,
      taskId: TaskIdSchema.optional(),
      reason: z.string(),
    })
    .passthrough(),
  phaseEvent('approval_sticky_recorded')
    .extend({
      pattern: z.string(),
      scope: z.enum(['session', 'always']),
      actionClass: ActionClassSchema,
    })
    .passthrough(),
  noPhaseEvent('approval_mode_changed')
    .extend({
      mode: z.enum(['yolo', 'normal']),
    })
    .passthrough(),
  phaseEvent('ipc_server_started').extend({ sockPath: z.string() }).passthrough(),
  phaseEvent('ipc_client_attached').passthrough(),
  phaseEvent('ipc_client_detached').passthrough(),
  phaseEvent('ipc_reconnect_attempt')
    .extend({
      attempt: z.number(),
      maxAttempts: z.number(),
    })
    .passthrough(),
  phaseEvent('ipc_reconnect_failed').passthrough(),
  phaseEvent('replay_started').extend({ totalEvents: z.number() }).passthrough(),
  phaseEvent('replay_complete')
    .extend({
      totalEvents: z.number(),
      durationMs: z.number(),
    })
    .passthrough(),
  phaseEvent('warning').extend({ message: z.string() }).passthrough(),
  phaseEvent('error').extend({ message: z.string() }).passthrough(),
]);

export function parseEngineEvent(value: unknown): EngineEvent | null {
  const result = EngineEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function eventPhase(event: EngineEvent): Phase | undefined {
  const result = PhaseSchema.safeParse(event.phase);
  return result.success ? result.data : undefined;
}
