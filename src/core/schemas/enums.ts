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
  'consulted',
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

export const REVIEW_VERDICTS = ['pass', 'pass_with_notes', 'fail'] as const;

export const REVIEW_STATUSES = ['passed', 'failed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** The halt causes a live producer raises. `scripts/invariants` checks each one has a producer. */
export const RECOVERY_REASONS = [
  'implementation-error',
  'retry-exhausted',
  'consult-bound-spent',
  'planner-calls-spent',
  'runner-unauthenticated',
  'runner-usage-limit',
  'context-overflow',
  'apply-conflict',
  'apply-partial',
  'dependency-blocked',
  'implementer-recipe-invalid',
  'implementer-left-isolation',
  'checkout-changed',
  'runner-timeout-repeated',
  'review-failed',
  'review-input-too-large',
  'required-checks-unrunnable',
  'approval-denied',
  'snapshot-failed',
  'planner-call-failed',
  'seat-protocol-error',
  'plan-questions-exhausted',
  'plan-checks-failed',
] as const;
/**
 * Causes nothing raises any more. A saved halt or a replayed event can still name one, so they
 * parse; continuing a run parked on one resolves it as stale.
 */
export const RETIRED_RECOVERY_REASONS = [
  'validation-failed',
  'user-edit-conflict',
  'approval-promotion-conflict',
  'scope-violation',
  'planner-returned-no-briefs',
  'constitution-check-failed',
  'brief-review-no-progress',
  'brief-quality-unrepaired',
] as const;
export const RecoveryReasonSchema = z.enum([...RECOVERY_REASONS, ...RETIRED_RECOVERY_REASONS]);
export type RecoveryReason = z.infer<typeof RecoveryReasonSchema>;
export type RetiredRecoveryReason = (typeof RETIRED_RECOVERY_REASONS)[number];

/** In the order a halt lists them: the least final first. */
export const RECOVERY_ACTIONS = [
  'continue',
  'retry-same-worker',
  'switch-seat',
  'retry-later',
  'revise',
  'accept-as-is',
  'restore-backup',
  'skip-current-task',
  'end-run',
] as const;
export const RecoveryActionSchema = z.enum(RECOVERY_ACTIONS);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

/**
 * Actions older runs saved or logged that no halt offers now. An old run's `revise-spec` sent its
 * note to the planner as `revise` does, and a bigger worker was a retry on another profile; a pause
 * and a split request have no successor and are dropped from the lists that held them.
 */
export const RETIRED_RECOVERY_ACTIONS: Readonly<Record<string, RecoveryAction | null>> = {
  'revise-spec': 'revise',
  'route-bigger-worker': 'retry-same-worker',
  'pause-run': null,
  'planner-split-rebase': null,
};

const RECOVERY_STATUSES = ['awaiting-user', 'applying'] as const;
/** A pause left the halt waiting; runs that saved one read as the halt it still was. */
export const RecoveryStatusSchema = z.preprocess(
  (value) => (value === 'paused' ? 'awaiting-user' : value),
  z.enum(RECOVERY_STATUSES),
);

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

/** Modes are retired: these parse what older runs saved, and nothing new is written. */
export const WORKFLOW_MODES = ['quick', 'standard', 'speckit'] as const;
export const RETIRED_WORKFLOW_MODE = 'instant' as const;
export const WorkflowModeSchema = z.preprocess(
  (value) => (value === RETIRED_WORKFLOW_MODE ? 'quick' : value),
  z.enum(WORKFLOW_MODES),
);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export const APPROVE_LEVELS = ['plan', 'none'] as const;
/** The levels before the one plan card. Each loads as `plan` with one notice. */
export const RETIRED_APPROVE_LEVELS = ['all', 'spec', 'default'] as const;
export const ApproveLevelSchema = z.preprocess(
  (value) => (includes(RETIRED_APPROVE_LEVELS, value) ? 'plan' : value),
  z.enum(APPROVE_LEVELS),
);
export type ApproveLevel = z.infer<typeof ApproveLevelSchema>;

/** Whether the reviewer checks wait for the user before they run (`ask`) or run at once (`auto`). */
export const APPROVE_CHECKS = ['ask', 'auto'] as const;
export const ApproveChecksSchema = z.enum(APPROVE_CHECKS);
export type ApproveChecks = z.infer<typeof ApproveChecksSchema>;

const BRIEF_REVIEW_PROMPT_KINDS = ['plan', 'artifact'] as const;
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
  'sensitive_change',
] as const;
export const ActionClassSchema = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof ActionClassSchema>;
/** A write in one of these classes always takes the confirm tier, whatever the config says. */
export const PROTECTED_ACTION_CLASSES: readonly ActionClass[] = [
  'destructive',
  'package_change',
  'sensitive_change',
];

export const COMMIT_STRATEGIES = ['none', 'checkpoint', 'per-task'] as const;
export const CommitStrategySchema = z.enum(COMMIT_STRATEGIES);
export type CommitStrategy = z.infer<typeof CommitStrategySchema>;

export const ISOLATION_STRATEGIES = ['worktree', 'staged-copy', 'none'] as const;
export const IsolationStrategySchema = z.enum(ISOLATION_STRATEGIES);
export type IsolationStrategy = z.infer<typeof IsolationStrategySchema>;

const OUTPUT_FORMATS = ['stream-json', 'jsonl', 'text', 'opencode'] as const;
export const OutputFormatSchema = z.enum(OUTPUT_FORMATS);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const CliToolIdSchema = z.enum(CLI_TOOL_IDS);

export const RUNNER_KINDS = ['cli', 'api', 'shell', 'agent'] as const;
export const RunnerKindSchema = z.enum(RUNNER_KINDS);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

// The one effort vocabulary, in the order GitHub Copilot's own `--effort` help prints it
// (`copilot --help` 1.0.77): every tool's ladder is a subset of these seven tokens.
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
