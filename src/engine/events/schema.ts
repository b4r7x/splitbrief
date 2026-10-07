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
  WorkflowModeSchema,
} from '../../core/schemas/enums.js';
import { CheckResultSchema, TaskIdSchema } from '../../core/schemas/task.js';
import { AnsweredQuestionSchema } from '../../core/schemas/question.js';
import { PlannerCallSchema, StepCutSchema, StepRefSchema } from '../../core/schemas/run-step.js';
import { ConsultRecordSchema } from '../../core/schemas/workflow.js';
import {
  readSavedRecoveryActions,
  SeatSwapCandidateSchema,
  TaskReviewRecoverySchema,
} from '../../core/schemas/recovery/schemas.js';
import { CREW_SEAT_IDS } from '../../core/crew/identity.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from '../../core/schemas/tokens.js';
import { RewindEventVariantSchemas } from '../../core/state/rewind-event.js';
import { RunnerCallTextChannelSchema } from '../../core/runner-call-contract.js';
import { WORKFLOW_CANCEL_REASONS } from './workflow-cancel.js';
import { TASK_REVIEW_COMMANDS } from './workflow-events.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  RunnerCallArtifactSchema,
  RunnerCallApiRuntimeStatusSchema,
  RunnerCallActivityKindSchema,
  RunnerCallActivityStageSchema,
  CallIdSchema,
  RUNNER_CALL_RAW_TAIL_MAX_LENGTH,
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
/** The seat a recovery event is about; absent on logs written before the field existed. */
const recoverySeat = z.enum(CREW_SEAT_IDS).optional();

// Live gates only ask at `confirm`; `sticky` stays so session logs from before its removal replay.
const ApprovalTierSchema = z.enum(['auto', 'sticky', 'confirm']);

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

function operationalMessageEvent<T extends 'warning' | 'error', S extends z.ZodRawShape>(
  type: T,
  shape: S,
) {
  const base = phaseEvent(type).extend({
    ...shape,
    message: z.string(),
    category: z.undefined().optional(),
    code: z.undefined().optional(),
  });
  const safe = phaseEvent(type).extend({
    ...shape,
    message: z.string(),
    category: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
  });
  return z.union([safe, base]);
}

const OperationalWarningEventSchema = operationalMessageEvent('warning', {});
const OperationalErrorEventSchema = operationalMessageEvent('error', {
  /** When a usage-limit halt's quota comes back, as the ISO instant its `resetAt` names. */
  resetAt: z.string().optional(),
});

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

  return parseWithSchema(EngineEventPayloadSchema, readSavedRecoveryEvent(value));
}

/** A logged recovery event names its actions in today's vocabulary; see `readSavedRecoveryActions`. */
function readSavedRecoveryEvent(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('recovery_')) {
    return value;
  }
  return readSavedRecoveryActions(value);
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
      reason: z.string(),
    })
    .optional(),
  recovery: TaskReviewRecoverySchema.optional(),
  availableCommands: z.array(z.enum(TASK_REVIEW_COMMANDS)),
} as const;

const EngineEventPayloadSchema = z.discriminatedUnion('type', [
  phaseEvent('workflow_started').extend({ feature: z.string() }),
  phaseEvent('workflow_resumed'),
  phaseEvent('workflow_complete').extend({
    review: z.enum(['passed', 'failed']).optional(),
    blocking: z.number().int().optional(),
    /** The run's completed briefs, those an earlier process completed included; absent on older logs. */
    completedTasks: z.number().int().nonnegative().optional(),
  }),
  phaseEvent('workflow_cancelled').extend({
    reason: WorkflowCancelReasonSchema.optional(),
  }),
  phaseEvent('turn_interrupted').extend({
    source: z.enum(['user', 'watchdog']).optional(),
    /** Where the stop landed: inside the call, or on a boundary — between two briefs, or at a gate. */
    at: StepCutSchema.optional(),
    /** The step the stop parked, as the state records it; absent on logs written before the field. */
    step: StepRefSchema.optional(),
  }),
  phaseEvent('workflow_config').extend({
    /** Written by runs before modes were retired; read only to replay them. */
    mode: WorkflowModeSchema.optional(),
    plannerTool: z.string(),
    plannerModel: z.string().optional(),
    implementerTool: z.string(),
    implementerModel: z.string().optional(),
    reviewerTool: z.string().optional(),
    reviewerModel: z.string().optional(),
    /** The ids of the skills every seat call of this run carries. */
    skills: z.array(z.string()).optional(),
  }),
  phaseEvent('recovery_prompted').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    taskId: TaskIdSchema.optional(),
    files: stringArray,
    affectedTaskIds: taskIdArray,
    availableActions: z.array(RecoveryActionSchema),
    recommendedAction: RecoveryActionSchema,
    headline: z.string(),
    resumeCommand: z.string(),
  }),
  phaseEvent('recovery_action_selected').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    seat: recoverySeat,
  }),
  phaseEvent('recovery_action_failed').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    seat: recoverySeat,
    message: z.string(),
  }),
  phaseEvent('recovery_resolved').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    seat: recoverySeat,
    outcome: z.enum(['continued', 'retry-current-task', 'skipped-current-task', 'aborted']),
    implementerProfile: z.string().optional(),
  }),
  phaseEvent('planner_status').extend({
    status: z.enum(['running', 'done']),
    tool: z.string().optional(),
    model: z.string().optional(),
    duration: z.number().optional(),
    summary: z.string().optional(),
    call: PlannerCallSchema.optional(),
  }),
  phaseEvent('planner_text').extend({
    text: z.string(),
    role: z.enum(['planner', 'implementer']).optional(),
    content: z.enum(['plain', 'markdown']).optional(),
    /** First chunk of a new implementer message; absent in older logs and continuous streams. */
    messageStart: z.boolean().optional(),
  }),
  phaseEvent('planner_heartbeat').extend({
    elapsedMs: z.number(),
    callId: CallIdSchema.optional(),
  }),
  strictCallPhaseEvent('runner_call_started'),
  strictCallPhaseEvent('runner_call_runtime_status').extend({
    runtimeStatus: RunnerCallApiRuntimeStatusSchema,
  }),
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
    /** Raw model ids a fallback or refusal warning names; display layers resolve them. */
    originalModel: z.string().min(1).max(256).optional(),
    fallbackModel: z.string().min(1).max(256).optional(),
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
    rawTail: z.string().max(RUNNER_CALL_RAW_TAIL_MAX_LENGTH).optional(),
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
  strictCallPhaseEvent('runner_call_heartbeat'),
  phaseEvent('artifact_written').extend({
    filename: z.string(),
    path: z.string(),
    lineCount: z.number().int().nonnegative(),
    excerpt: stringArray,
    omittedCount: z.number().int().nonnegative(),
    omittedUnit: z.enum(['line', 'section', 'task']),
  }),
  phaseEvent('spec_approved'),
  phaseEvent('spec_rejected'),
  phaseEvent('spec_regenerated').extend({ comment: z.string() }),
  phaseEvent('plan_approved'),
  phaseEvent('plan_rejected'),
  phaseEvent('plan_regenerated').extend({ comment: z.string() }),
  phaseEvent('briefs_approved'),
  phaseEvent('briefs_rejected'),
  ...RewindEventVariantSchemas,
  phaseEvent('all_tasks_done'),
  phaseEvent('drift_report').extend({
    passed: z.boolean(),
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
    kind: z.enum(['none', 'downgrade', 'upgrade', 'missing-context', 'stop']),
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
    /** The attempt this brief's lineage is on, and its allowance; absent on older logs. */
    lineageAttempt: z.number().int().positive().optional(),
    attemptAllowance: z.number().int().nonnegative().optional(),
    file: z.string(),
    files: stringArray.optional(),
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
    /** The attempt this retry is on its lineage, and the lineage's allowance; absent on older logs. */
    lineageAttempt: z.number().int().positive().optional(),
    attemptAllowance: z.number().int().nonnegative().optional(),
    error: z.string(),
  }),
  phaseEvent('task_escalating').extend({ taskId: TaskIdSchema }),
  phaseEvent('task_scope_widened').extend({
    taskId: TaskIdSchema,
    paths: stringArray,
    reason: z.string(),
  }),
  phaseEvent('task_touched_not_suggested').extend({ taskId: TaskIdSchema, files: stringArray }),
  phaseEvent('task_full_fail').extend({ taskId: TaskIdSchema, reason: z.string().optional() }),
  phaseEvent('review_fix_started').extend({
    cycle: z.number().int(),
    taskIds: taskIdArray,
  }),
  phaseEvent('task_tokens').extend({
    taskId: TaskIdSchema,
    method: TaskCompletionMethodSchema,
    implementerTokens: z.number().int().nonnegative(),
    escalationTokens: z.number().int().nonnegative(),
    implementerCacheReadTokens: z.number().nonnegative().optional(),
    implementerCacheCreateTokens: z.number().nonnegative().optional(),
    escalationCacheReadTokens: z.number().nonnegative().optional(),
    escalationCacheCreateTokens: z.number().nonnegative().optional(),
    implementerInputTokens: z.number().nonnegative().optional(),
    implementerOutputTokens: z.number().nonnegative().optional(),
    implementerReasoningTokens: z.number().nonnegative().optional(),
    escalationInputTokens: z.number().nonnegative().optional(),
    escalationOutputTokens: z.number().nonnegative().optional(),
    escalationReasoningTokens: z.number().nonnegative().optional(),
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
    routingReason: z.string().optional(),
  }),
  phaseEvent('task_review_needed').extend(taskReviewRequestFields),
  phaseEvent('hint_failed').extend({ taskId: TaskIdSchema }),
  phaseEvent('consult_answered').extend({
    taskId: TaskIdSchema,
    reason: ConsultRecordSchema.shape.reason,
    action: ConsultRecordSchema.shape.action,
    diagnosis: z.string(),
    newTaskIds: taskIdArray.nullable(),
    revision: z.number().int().optional(),
    checkIds: z.array(z.string()).optional(),
    decisionCount: z.number().int().nonnegative().optional(),
  }),
  phaseEvent('task_replaced').extend({
    taskId: TaskIdSchema,
    revision: z.number().int(),
  }),
  phaseEvent('tasks_inserted').extend({
    parentId: TaskIdSchema,
    taskIds: taskIdArray,
  }),
  phaseEvent('checks_run').extend({
    taskId: TaskIdSchema,
    results: z.array(CheckResultSchema),
  }),
  phaseEvent('seat_wait_started').extend({
    seat: z.enum(CREW_SEAT_IDS),
    resetAt: z.string(),
  }),
  phaseEvent('seat_switched').extend({
    seat: z.enum(CREW_SEAT_IDS),
    from: SeatSwapCandidateSchema,
    to: SeatSwapCandidateSchema,
    cause: RecoveryReasonSchema,
    auto: z.boolean(),
    configRevision: z.string(),
  }),
  phaseEvent('seat_retry').extend({
    seat: z.enum(CREW_SEAT_IDS),
    attempt: z.number().int().nonnegative(),
    delayMs: z.number().int().nonnegative(),
  }),
  phaseEvent('no_progress_cut').extend({
    taskId: TaskIdSchema.nullable(),
    seat: z.enum(CREW_SEAT_IDS),
    silentMs: z.number().int().nonnegative(),
  }),
  phaseEvent('consult_bound_spent'),
  phaseEvent('implementer_generate_running').extend({
    taskId: TaskIdSchema,
    file: z.string().optional(),
  }),
  phaseEvent('implementer_generate_done').extend({
    taskId: TaskIdSchema,
    file: z.string(),
    diff: z.string().optional(),
    /** Absent when the call's baseline kept no content to count against. */
    linesAdded: z.number().optional(),
    linesRemoved: z.number().optional(),
    duration: z.number(),
    /** An allowed no-change attempt that verified its brief and changed nothing. */
    noChange: z.literal(true).optional(),
  }),
  phaseEvent('implementer_generate_failed').extend({
    taskId: TaskIdSchema,
    model: z.string().optional(),
    error: z.string().optional(),
  }),
  phaseEvent('validate').extend({
    taskId: TaskIdSchema,
    status: z.enum(['running', 'done']),
    passed: z.boolean(),
    exempt: z.boolean().optional(),
    stages: validationStagesSchema,
    attempted: validationStageAttemptsSchema.optional(),
    activeStage: z.enum(['typecheck', 'lint', 'test']).optional(),
    commands: validationStageCommandsSchema.optional(),
    skipped: validationStageSkipsSchema.optional(),
    skippedReason: z.record(z.string(), z.string()).optional(),
    error: z.string().optional(),
    duration: z.number().optional(),
  }),
  phaseEvent('full_suite').extend({
    status: z.enum(['running', 'done', 'not-run']),
    stage: z.enum(['typecheck', 'lint', 'test']),
    command: z.string(),
    moment: z.enum(['pre-review', 'base']),
    passed: z.boolean().optional(),
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
    files: stringArray.optional(),
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
  phaseEvent('user_message').extend({
    text: z.string(),
    qa: z.array(AnsweredQuestionSchema).optional(),
  }),
  phaseEvent('planner_attachments_dropped').extend({
    count: z.number(),
    reason: z.enum(['unsupported-backend', 'capability-degraded']),
  }),
  phaseEvent('cost_update').extend({ tokenUsage: TokenUsageSchema }),
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
