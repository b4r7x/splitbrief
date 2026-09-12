import { z } from 'zod';
import { includes } from '../../utils/type-guards.js';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import {
  CLI_TOOL_IDS,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../runners/cli-tool-catalog.js';

export const META_PROVIDER_IDS = ['shell', 'agent'] as const;

export const PROVIDER_IDS = [
  ...CLI_TOOL_IDS,
  ...REMOTE_API_PROVIDER_IDS,
  ...LOCAL_API_PROVIDER_IDS,
  ...META_PROVIDER_IDS,
] as const;

export const PLANNER_TOOL_IDS = [
  ...PLANNER_CLI_TOOL_IDS,
  ...PLANNER_API_PROVIDER_IDS,
  ...META_PROVIDER_IDS,
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type PlannerToolId = (typeof PLANNER_TOOL_IDS)[number];

export const PlannerCliToolIdSchema = z.enum(PLANNER_CLI_TOOL_IDS);
export type PlannerCliToolId = z.infer<typeof PlannerCliToolIdSchema>;

export const ImplementerCliToolIdSchema = z.enum(IMPLEMENTER_CLI_TOOL_IDS);
export type ImplementerCliToolId = z.infer<typeof ImplementerCliToolIdSchema>;

export const PlannerApiProviderIdSchema = z.enum(PLANNER_API_PROVIDER_IDS);

export const ImplementerApiProviderIdSchema = z.enum(IMPLEMENTER_API_PROVIDER_IDS);

export function isProviderId(id: string): id is ProviderId {
  return includes(PROVIDER_IDS, id);
}

export const PHASES = [
  'idle',
  'researching',
  'specifying',
  'reviewing-spec',
  'clarifying',
  'constitution-check',
  'planning',
  'reviewing-plan',
  'reviewing-briefs',
  'analyzing',
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
  'complete',
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const FileActionSchema = z.enum(['create', 'modify']);

const TASK_COMPLETION_METHODS = [
  'local',
  'escalated-intermediate',
  'escalated-hint',
  'escalated-full',
  'failed',
  'skipped',
] as const;
// 0.1.0 persisted 'mcp-tool' for a task the removed MCP tool marked done.
// Nothing writes it any more, so reads map it onto the local completion it was.
export const TaskCompletionMethodSchema = z.preprocess(
  (value) => (value === 'mcp-tool' ? 'local' : value),
  z.enum(TASK_COMPLETION_METHODS),
);
export type TaskCompletionMethod = z.infer<typeof TaskCompletionMethodSchema>;

export const VALIDATION_STAGES = ['typecheck', 'lint', 'test'] as const;
export const ValidationStageSchema = z.enum(VALIDATION_STAGES);
export type ValidationStage = z.infer<typeof ValidationStageSchema>;

export const RECOVERY_REASONS = [
  'implementation-error',
  'validation-failed',
  'retry-exhausted',
  'runner-unauthenticated',
  'runner-usage-limit',
  'context-overflow',
  'user-edit-conflict',
  'approval-promotion-conflict',
  'budget-paused',
  'budget-exceeded',
  'dependency-blocked',
] as const;
export const RecoveryReasonSchema = z.enum(RECOVERY_REASONS);
export type RecoveryReason = z.infer<typeof RecoveryReasonSchema>;

export const RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'switch-seat',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const;
export const RecoveryActionSchema = z.enum(RECOVERY_ACTIONS);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const PROMPTABLE_RECOVERY_ACTIONS: RecoveryAction[] = [
  'retry-same-worker',
  'route-bigger-worker',
  'switch-seat',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
];

const RECOVERY_STATUSES = ['awaiting-user', 'paused', 'applying'] as const;
export const RecoveryStatusSchema = z.enum(RECOVERY_STATUSES);

export const USER_EDIT_CONFLICT_KINDS = [
  'unrelated',
  'current-task-conflict',
  'future-task-stale-input',
  'dependency-file-conflict',
  'changed-during-approval-promotion',
] as const;
export const UserEditConflictKindSchema = z.enum(USER_EDIT_CONFLICT_KINDS);
export type UserEditConflictKind = z.infer<typeof UserEditConflictKindSchema>;

export const USER_EDIT_CONFLICT_ACTIONS = [
  'continue-unrelated',
  'pause',
  'skip-current-task',
  'abort-workflow',
] as const;
export const UserEditConflictActionSchema = z.enum(USER_EDIT_CONFLICT_ACTIONS);
export type UserEditConflictAction = z.infer<typeof UserEditConflictActionSchema>;

export const TASK_CONTEXT_FITS = ['fits', 'tight', 'overflow'] as const;
export const TaskContextFitSchema = z.enum(TASK_CONTEXT_FITS);
export type TaskContextFit = z.infer<typeof TaskContextFitSchema>;

export const CURRENT_CODE_CONTEXT_MODES = [
  'none',
  'whole-file',
  'function-level',
  'truncated',
] as const;
export const CurrentCodeContextModeSchema = z.enum(CURRENT_CODE_CONTEXT_MODES);
export type CurrentCodeContextMode = z.infer<typeof CurrentCodeContextModeSchema>;

export const WORKFLOW_MODES = ['quick', 'standard', 'speckit'] as const;
export const RETIRED_WORKFLOW_MODE = 'instant' as const;
export const RETIRED_WORKFLOW_MODE_NOTICE =
  'workflow mode "instant" was merged into "quick"; using quick. Update your config or --mode flag.';
export const WorkflowModeSchema = z.preprocess(
  (value) => (value === RETIRED_WORKFLOW_MODE ? 'quick' : value),
  z.enum(WORKFLOW_MODES),
);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export function normalizeWorkflowMode(raw: string | undefined): WorkflowMode | undefined {
  const parsed = WorkflowModeSchema.safeParse(raw?.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

export const APPROVE_LEVELS = ['none', 'spec', 'plan', 'all', 'default'] as const;
export const ApproveLevelSchema = z.enum(APPROVE_LEVELS);
export type ApproveLevel = z.infer<typeof ApproveLevelSchema>;

const BRIEF_REVIEW_PROMPT_KINDS = ['spec', 'plan', 'briefs', 'artifact'] as const;
const BriefReviewPromptKindSchema = z.enum(BRIEF_REVIEW_PROMPT_KINDS);
export type BriefReviewPromptKind = z.infer<typeof BriefReviewPromptKindSchema>;

const ACTION_CLASSES = [
  'read',
  'write_in_scope',
  'validation',
  'write_out_of_scope',
  'destructive',
  'network',
  'package_change',
] as const;
export const ActionClassSchema = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const COMMIT_STRATEGIES = ['none', 'checkpoint', 'per-task'] as const;
export const CommitStrategySchema = z.enum(COMMIT_STRATEGIES);
export type CommitStrategy = z.infer<typeof CommitStrategySchema>;

export const ISOLATION_STRATEGIES = ['worktree', 'staged-copy'] as const;
export const IsolationStrategySchema = z.enum(ISOLATION_STRATEGIES);
export type IsolationStrategy = z.infer<typeof IsolationStrategySchema>;

const OUTPUT_FORMATS = ['stream-json', 'jsonl', 'text', 'opencode'] as const;
export const OutputFormatSchema = z.enum(OUTPUT_FORMATS);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const CliToolIdSchema = z.enum(CLI_TOOL_IDS);

export const RUNNER_KINDS = ['cli', 'api', 'shell', 'agent'] as const;
const RunnerKindSchema = z.enum(RUNNER_KINDS);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

// The one effort vocabulary, in the order GitHub Copilot's own `--effort` help prints it
// (`copilot --help` 1.0.77): every tool's ladder is a subset of these seven tokens.
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
