import { z } from 'zod';
import {
  ActionClassSchema,
  ApproveLevelSchema,
  CurrentCodeContextModeSchema,
  FileActionSchema,
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
import { TaskReviewRecoverySchema } from '../../core/schemas/recovery/schemas.js';
import { CostPredictionSchema } from '../../core/schemas/summary.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from '../../core/schemas/tokens.js';
import { RewindEventVariantSchemas } from '../../core/state/rewind-event.js';
import { RunnerCallTextChannelSchema } from '../../core/runner-call-contract.js';
import { WORKFLOW_CANCEL_REASONS } from './workflow-cancel.js';
import { TASK_REVIEW_COMMANDS } from './workflow-events.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  RunnerCallArtifactSchema,
  RunnerCallActivityKindSchema,
  RunnerCallActivityStageSchema,
  CallIdSchema,
  RunnerCallErrorSchema,
  RunnerCallFailureStatusSchema,
  RunnerCallTextSemanticsSchema,
  RunnerCallToolUseSchema,
  RunnerCallUsageSchema,
  RunnerCallUsageSemanticsSchema,
  RunnerCallWarningSchema,
  runnerCallContextFields,
  runnerCallTerminalFields,
} from '../calls/schema.js';

const stringArray = z.array(z.string());
const taskIdArray = z.array(TaskIdSchema);

function phaseEvent<T extends string>(type: T) {
  return z.looseObject({
    type: z.literal(type),
    ts: z.number(),
    phase: PhaseSchema,
  });
}

function noPhaseEvent<T extends string>(type: T) {
  return z.looseObject({
    type: z.literal(type),
    ts: z.number(),
  });
}

function operationalMessageEvent<T extends 'warning' | 'error'>(type: T) {
  const base = phaseEvent(type).extend({
    message: z.string(),
    category: z.undefined().optional(),
    code: z.undefined().optional(),
    transcriptSafe: z.undefined().optional(),
  });
  const safe = phaseEvent(type).extend({
    message: z.string(),
    category: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    transcriptSafe: z.literal(true),
  });
  return z.union([safe, base]);
}

const OperationalWarningEventSchema = operationalMessageEvent('warning');
const OperationalErrorEventSchema = operationalMessageEvent('error');

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function parseOperationalMessageEvent(value: unknown): EngineEventFromPayloadSchemas | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'warning':
      return parseWithSchema(OperationalWarningEventSchema, value);
    case 'error':
      return parseWithSchema(OperationalErrorEventSchema, value);
    default:
      return null;
  }
}

function parseEngineEventPayload(value: unknown): EngineEventFromPayloadSchemas | null {
  const operationalMessage = parseOperationalMessageEvent(value);
  if (operationalMessage !== null) return operationalMessage;

  return parseWithSchema(EngineEventPayloadSchema, value);
}

function invalidEngineEventMessage(value: unknown): string {
  const type = isRecord(value) && typeof value.type === 'string' ? ` "${value.type}"` : '';
  return `Invalid engine event${type}`;
}

function strictCallPhaseEvent<T extends string>(type: T) {
  return z.strictObject({
    type: z.literal(type),
    ts: z.number(),
    phase: PhaseSchema,
    taskId: TaskIdSchema.optional(),
    ...runnerCallContextFields,
    sequence: z.number().int().nonnegative(),
  });
}

const validationStagesSchema = z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  test: z.boolean(),
});

const validationStageSkipsSchema = z.object({
  typecheck: z.boolean().optional(),
  lint: z.boolean().optional(),
  test: z.boolean().optional(),
});

const validationStageAttemptsSchema = z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  test: z.boolean(),
});

const validationStageCommandsSchema = z.object({
  typecheck: z.string().optional(),
  lint: z.string().optional(),
  test: z.string().optional(),
});

const replayDiagnosticsSchema = z.object({
  totalLines: z.number().int().nonnegative(),
  replayedEvents: z.number().int().nonnegative(),
  skippedBlank: z.number().int().nonnegative(),
  skippedNonEvent: z.number().int().nonnegative(),
  skippedMalformed: z.number().int().nonnegative(),
  skippedUnknown: z.number().int().nonnegative(),
  skippedOversized: z.number().int().nonnegative(),
});

const runnerCallToolUseEventBase = strictCallPhaseEvent('runner_call_tool_use');

const runnerCallToolUseEventSchema = z.discriminatedUnion('stage', [
  runnerCallToolUseEventBase.extend({
    stage: z.literal('delta'),
    toolUseId: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    inputDelta: z.string(),
  }),
  runnerCallToolUseEventBase.extend({
    stage: z.literal('done'),
    toolUse: RunnerCallToolUseSchema,
  }),
]);

export const WorkflowCancelReasonSchema = z.enum(WORKFLOW_CANCEL_REASONS);

export const userEditConflictSchema = z.looseObject({
  kind: UserEditConflictKindSchema,
  files: stringArray,
  affectedTaskIds: taskIdArray,
  currentTaskId: TaskIdSchema.optional(),
  fileConflicts: z.array(
    z.looseObject({
      file: z.string(),
      kind: UserEditConflictKindSchema,
      affectedTaskIds: taskIdArray,
    }),
  ),
  safeToContinue: z.boolean(),
  availableActions: z.array(UserEditConflictActionSchema),
});

export const taskReviewRequestFields = {
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  status: z.union([TaskStatusSchema, z.literal('recovery-required')]),
  filesTouched: stringArray,
  validation: z.looseObject({
    passed: z.boolean().nullable(),
    summary: z.string(),
    stages: z.array(
      z.looseObject({
        stage: z.string(),
        passed: z.boolean(),
        errorSummary: z.string().optional(),
      }),
    ),
  }),
  evidence: z.looseObject({
    path: z.string().optional(),
    summary: z.string(),
    expected: stringArray,
    observed: stringArray,
  }),
  cost: z.looseObject({
    tokenUsage: TokenUsageSchema,
    taskTokens: TaskTokenUsageSchema.optional(),
    tool: z.string().optional(),
    model: z.string().optional(),
    implementerProfile: z.string().optional(),
  }),
  routing: z
    .looseObject({
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
    .optional(),
  recovery: TaskReviewRecoverySchema.optional(),
  availableCommands: z.array(z.enum(TASK_REVIEW_COMMANDS)),
} as const;

const EngineEventPayloadSchema = z.discriminatedUnion('type', [
  phaseEvent('workflow_started').extend({ feature: z.string() }),
  phaseEvent('workflow_resumed'),
  phaseEvent('workflow_complete'),
  phaseEvent('workflow_cancelled').extend({
    reason: WorkflowCancelReasonSchema.optional(),
  }),
  phaseEvent('turn_interrupted').extend({
    source: z.enum(['user', 'watchdog']).optional(),
  }),
  phaseEvent('workflow_config').extend({
    mode: WorkflowModeSchema,
    plannerTool: z.string(),
    plannerModel: z.string().optional(),
    implementerTool: z.string(),
    implementerModel: z.string().optional(),
  }),
  phaseEvent('paused_external_changes').extend({
    conflict: userEditConflictSchema.optional(),
    selectedAction: UserEditConflictActionSchema.optional(),
  }),
  phaseEvent('recovery_prompted').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    taskId: TaskIdSchema.optional(),
    files: stringArray,
    affectedTaskIds: taskIdArray,
    availableActions: z.array(RecoveryActionSchema),
    recommendedAction: RecoveryActionSchema,
  }),
  phaseEvent('recovery_action_selected').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
  }),
  phaseEvent('recovery_action_failed').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    message: z.string(),
  }),
  phaseEvent('recovery_resolved').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    outcome: z.enum(['continued', 'retry-current-task', 'skipped-current-task', 'aborted']),
    implementerProfile: z.string().optional(),
  }),
  phaseEvent('planner_status').extend({
    status: z.enum(['running', 'done']),
    tool: z.string().optional(),
    model: z.string().optional(),
    duration: z.number().optional(),
    summary: z.string().optional(),
  }),
  phaseEvent('planner_text').extend({
    text: z.string(),
    role: z.enum(['planner', 'implementer']).optional(),
    content: z.enum(['plain', 'markdown']).optional(),
  }),
  phaseEvent('planner_heartbeat').extend({
    elapsedMs: z.number(),
    accumulatedTokens: z.number(),
    callId: CallIdSchema.optional(),
    phaseHint: z.string().optional(),
  }),
  strictCallPhaseEvent('runner_call_started'),
  strictCallPhaseEvent('runner_call_text_delta').extend({
    channel: RunnerCallTextChannelSchema,
    text: z.string(),
    semantics: RunnerCallTextSemanticsSchema.optional(),
  }),
  strictCallPhaseEvent('runner_call_usage').extend({
    usage: RunnerCallUsageSchema,
    semantics: RunnerCallUsageSemanticsSchema,
  }),
  runnerCallToolUseEventSchema,
  strictCallPhaseEvent('runner_call_activity').extend({
    activityId: z.string().min(1).max(512),
    stage: RunnerCallActivityStageSchema,
    kind: RunnerCallActivityKindSchema,
    label: z.string().min(1).max(512),
    target: z.string().min(1).max(2048).optional(),
    redacted: z.boolean(),
    rawAvailable: z.boolean().optional(),
    expandId: z.string().min(1).max(512).optional(),
    textPartial: z.string().min(1).max(2048).optional(),
    diagnosticPartial: z.string().min(1).max(2048).optional(),
  }),
  strictCallPhaseEvent('runner_call_session_id').extend({
    nativeSessionId: z.string(),
  }),
  strictCallPhaseEvent('runner_call_artifact').extend({
    artifact: RunnerCallArtifactSchema,
  }),
  strictCallPhaseEvent('runner_call_warning').extend({
    warning: RunnerCallWarningSchema,
  }),
  strictCallPhaseEvent('runner_call_error').extend({
    status: RunnerCallFailureStatusSchema,
    error: RunnerCallErrorSchema,
    partial: z.boolean(),
    ...runnerCallTerminalFields,
  }),
  strictCallPhaseEvent('runner_call_completed').extend({
    status: z.literal('completed'),
    error: z.null(),
    partial: z.literal(false),
    ...runnerCallTerminalFields,
  }),
  strictCallPhaseEvent('runner_call_stalled').extend({
    silentMs: z.number().int().nonnegative(),
  }),
  strictCallPhaseEvent('runner_call_stall_cleared'),
  phaseEvent('artifact_written').extend({
    filename: z.string(),
    path: z.string(),
    lineCount: z.number().int().nonnegative(),
    excerpt: stringArray,
    omittedCount: z.number().int().nonnegative(),
    omittedUnit: z.enum(['line', 'section', 'task']),
  }),
  phaseEvent('spec_rejected'),
  phaseEvent('spec_regenerated').extend({ comment: z.string() }),
  phaseEvent('plan_approved'),
  phaseEvent('plan_rejected'),
  phaseEvent('plan_regenerated').extend({ comment: z.string() }),
  ...RewindEventVariantSchemas,
  phaseEvent('all_tasks_done'),
  phaseEvent('brief_quality_passed').extend({
    score: z.number(),
    warningCount: z.number(),
  }),
  phaseEvent('brief_quality_failed').extend({
    score: z.number(),
    errorCount: z.number(),
    warningCount: z.number(),
  }),
  phaseEvent('brief_readiness_passed').extend({
    taskCount: z.number(),
  }),
  phaseEvent('brief_readiness_blocked').extend({
    taskCount: z.number(),
    blockedCount: z.number(),
    blockedTaskIds: stringArray,
    kinds: stringArray,
  }),
  phaseEvent('drift_report').extend({
    passed: z.boolean(),
    score: z.number(),
    errorCount: z.number(),
    warningCount: z.number(),
  }),
  phaseEvent('drift_chain_detected').extend({
    chainLength: z.number(),
    score: z.number(),
    threshold: z.number(),
    uniqueOutOfBoundsFiles: stringArray,
    representativePath: z.string(),
  }),
  phaseEvent('snapshot_created').extend({
    snapshotId: z.string(),
    name: z.string().optional(),
    fileCount: z.number(),
    taskIndex: z.number().optional(),
  }),
  noPhaseEvent('snapshot_restored').extend({
    snapshotId: z.string(),
    restoredCount: z.number(),
    conflictedCount: z.number(),
    forcedCount: z.number(),
    forced: z.boolean(),
  }),
  noPhaseEvent('snapshot_restore_conflict').extend({
    snapshotId: z.string(),
    conflictedPaths: stringArray,
  }),
  phaseEvent('mode_resolved').extend({
    mode: WorkflowModeSchema,
    approve: ApproveLevelSchema,
  }),
  phaseEvent('mode_advice').extend({
    kind: z.enum(['none', 'downgrade', 'upgrade', 'missing-context']),
    risk: z.enum(['trivial', 'small', 'normal', 'high']),
    currentMode: WorkflowModeSchema,
    suggestedMode: WorkflowModeSchema,
    confidence: z.number(),
    factors: stringArray,
    missing: stringArray,
  }),
  phaseEvent('instant_plan_received').extend({ taskCount: z.number() }),
  phaseEvent('tasks_planned').extend({
    tasks: z.array(
      z.object({
        id: TaskIdSchema,
        title: z.string(),
        index: z.number().int().nonnegative(),
        file: z.string(),
        action: FileActionSchema,
      }),
    ),
    total: z.number().int().nonnegative(),
  }),
  phaseEvent('task_started').extend({
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
  }),
  phaseEvent('task_completed').extend({
    taskId: TaskIdSchema,
    title: z.string(),
    method: TaskCompletionMethodSchema,
    retries: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    tool: z.string().optional(),
    model: z.string().optional(),
    implementerProfile: z.string().optional(),
  }),
  phaseEvent('task_skipped').extend({
    taskId: TaskIdSchema,
    title: z.string(),
    reason: z.string(),
  }),
  phaseEvent('task_retry').extend({
    taskId: TaskIdSchema,
    attempt: z.number().int().nonnegative(),
    maxRetries: z.number().int().nonnegative(),
    error: z.string(),
  }),
  phaseEvent('task_escalating').extend({ taskId: TaskIdSchema }),
  phaseEvent('task_full_fail').extend({ taskId: TaskIdSchema }),
  phaseEvent('task_tokens').extend({
    taskId: TaskIdSchema,
    method: TaskCompletionMethodSchema,
    implementerTokens: z.number().int().nonnegative(),
    escalationTokens: z.number().int().nonnegative(),
    implementerCacheReadTokens: z.number().nonnegative().optional(),
    implementerCacheCreateTokens: z.number().nonnegative().optional(),
    escalationCacheReadTokens: z.number().nonnegative().optional(),
    escalationCacheCreateTokens: z.number().nonnegative().optional(),
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
  }),
  phaseEvent('task_review_needed').extend(taskReviewRequestFields),
  phaseEvent('hint_failed').extend({ taskId: TaskIdSchema }),
  phaseEvent('implementer_generate_running').extend({
    taskId: TaskIdSchema,
    file: z.string().optional(),
  }),
  phaseEvent('implementer_generate_done').extend({
    taskId: TaskIdSchema,
    file: z.string(),
    diff: z.string().optional(),
    linesAdded: z.number(),
    linesRemoved: z.number(),
    duration: z.number(),
  }),
  phaseEvent('implementer_generate_failed').extend({
    taskId: TaskIdSchema,
    model: z.string().optional(),
  }),
  phaseEvent('validate').extend({
    taskId: TaskIdSchema,
    status: z.enum(['running', 'done']),
    passed: z.boolean(),
    stages: validationStagesSchema,
    attempted: validationStageAttemptsSchema.optional(),
    activeStage: z.enum(['typecheck', 'lint', 'test']).optional(),
    commands: validationStageCommandsSchema.optional(),
    skipped: validationStageSkipsSchema.optional(),
    error: z.string().optional(),
    duration: z.number().optional(),
  }),
  phaseEvent('validation_baseline').extend({
    status: z.enum(['running', 'done']),
    stages: validationStagesSchema,
    activeStage: z.enum(['typecheck', 'lint', 'test']).optional(),
    commands: validationStageCommandsSchema.optional(),
    failing: validationStageSkipsSchema.optional(),
    duration: z.number().optional(),
  }),
  phaseEvent('escalate').extend({
    taskId: TaskIdSchema,
    tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    hint: z.string().optional(),
    tool: z.string().optional(),
    model: z.string().optional(),
  }),
  phaseEvent('git_commit').extend({
    taskId: TaskIdSchema,
    message: z.string(),
    file: z.string().optional(),
  }),
  phaseEvent('git_checkpoint').extend({
    taskId: TaskIdSchema,
    tag: z.string(),
  }),
  phaseEvent('git_branch_created').extend({ name: z.string() }),
  phaseEvent('clarifications_collected').extend({
    count: z.number(),
    clarifications: z.array(
      z.looseObject({
        question: z.string(),
        answer: z.string(),
      }),
    ),
  }),
  phaseEvent('clarification_answered').extend({
    answer: z.string(),
  }),
  phaseEvent('message_queued').extend({
    id: z.string(),
    preview: z.string().optional(),
    origin: z.enum(['user-input', 'clarification']).optional(),
  }),
  phaseEvent('message_injected_native').extend({ id: z.string(), preview: z.string().optional() }),
  phaseEvent('queue_drained').extend({
    count: z.number().int().nonnegative(),
    ids: z.array(z.string()).optional(),
  }),
  phaseEvent('queue_cleared').extend({ count: z.number().int().nonnegative() }),
  phaseEvent('user_message').extend({ text: z.string() }),
  phaseEvent('planner_attachments_dropped').extend({
    count: z.number(),
    reason: z.enum(['unsupported-backend', 'capability-degraded']),
  }),
  phaseEvent('cost_update').extend({ tokenUsage: TokenUsageSchema }),
  phaseEvent('cost_prediction').extend({ prediction: CostPredictionSchema }),
  phaseEvent('budget_warning').extend({
    currentCost: z.number(),
    maxBudget: z.number(),
  }),
  phaseEvent('budget_paused').extend({
    currentCost: z.number(),
    maxBudget: z.number(),
    threshold: z.number(),
  }),
  phaseEvent('budget_exceeded').extend({
    currentCost: z.number(),
    maxBudget: z.number(),
  }),
  phaseEvent('approval_prompted').extend({
    tier: ApprovalTierSchema,
    actionClass: ActionClassSchema,
    taskId: TaskIdSchema.optional(),
  }),
  phaseEvent('approval_granted').extend({
    tier: ApprovalTierSchema,
    actionClass: ActionClassSchema,
    taskId: TaskIdSchema.optional(),
    scope: z.enum(['once', 'session', 'always']),
    confirmReason: z.string().optional(),
  }),
  phaseEvent('approval_rejected').extend({
    tier: ApprovalTierSchema,
    actionClass: ActionClassSchema,
    taskId: TaskIdSchema.optional(),
    reason: z.string(),
  }),
  phaseEvent('approval_sticky_recorded').extend({
    pattern: z.string(),
    scope: z.enum(['session', 'always']),
    actionClass: ActionClassSchema,
  }),
  noPhaseEvent('approval_mode_changed').extend({
    mode: z.enum(['yolo', 'normal']),
  }),
  phaseEvent('ipc_server_started').extend({ sockPath: z.string() }),
  phaseEvent('ipc_client_attached'),
  phaseEvent('ipc_client_detached'),
  phaseEvent('ipc_reconnect_attempt').extend({
    attempt: z.number(),
    maxAttempts: z.number(),
  }),
  phaseEvent('ipc_reconnect_failed'),
  phaseEvent('replay_started').extend({
    totalEvents: z.number(),
    diagnostics: replayDiagnosticsSchema.optional(),
  }),
  phaseEvent('replay_complete').extend({
    totalEvents: z.number(),
    durationMs: z.number(),
    diagnostics: replayDiagnosticsSchema.optional(),
  }),
]);

type EngineEventFromPayloadSchemas =
  | z.infer<typeof EngineEventPayloadSchema>
  | z.infer<typeof OperationalWarningEventSchema>
  | z.infer<typeof OperationalErrorEventSchema>;

export const EngineEventSchema = z
  .unknown()
  .transform((value, ctx): EngineEventFromPayloadSchemas => {
    const parsed = parseEngineEventPayload(value);
    if (parsed !== null) return parsed;
    ctx.addIssue({ code: 'custom', path: [], message: invalidEngineEventMessage(value) });
    return z.NEVER;
  });

type EngineEventFromSchema = z.infer<typeof EngineEventSchema>;

export function parseEngineEvent(value: unknown): EngineEventFromSchema | null {
  const result = EngineEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
