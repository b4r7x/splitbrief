import { z } from 'zod';
import { WorkflowModeSchema, CommitStrategySchema, ApproveLevelSchema, ThemeModeSchema, ShikiThemeSchema } from './enums.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ImplementerConfigSchema, ImplementerProfilesConfigSchema } from './implementer-config.js';
import { CodebaseConfigSchema } from './codebase.js';
import { HooksConfigSchema } from './hooks.js';
import { OtelConfigSchema } from './otel.js';
import { CompactionFormatSchema } from './compaction.js';

const PaletteCustomActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  command: z.string().startsWith('/'),
});

const PaletteConfigSchema = z.object({
  customActions: z.array(PaletteCustomActionSchema).optional(),
});

export type PaletteCustomAction = z.infer<typeof PaletteCustomActionSchema>;
export type PaletteConfig = z.infer<typeof PaletteConfigSchema>;

export const SnapshotsAutoConfigSchema = z.object({
  preTask: z.boolean().optional(),
  postTask: z.boolean().optional(),
  preFinalReview: z.boolean().optional(),
});

export const SnapshotsConfigSchema = z.object({
  auto: SnapshotsAutoConfigSchema.optional(),
});

export const EscalationConfigSchema = z.object({
  intermediateProvider: z.string().optional(),
  intermediateModel: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const GitWorkflowConfigSchema = z.object({
  commitStrategy: CommitStrategySchema.optional(),
  createBranch: z.boolean().optional(),
});

export const TaskReviewModeSchema = z.enum(['none', 'failed', 'every']);
export type TaskReviewMode = z.infer<typeof TaskReviewModeSchema>;

export const SpeckitWorkflowConfigSchema = z.object({
  minCoverage: z.number().min(0).max(1).optional(),
});

export const ApprovalTierSchema = z.enum(['auto', 'sticky', 'confirm']);
export type ApprovalTier = z.infer<typeof ApprovalTierSchema>;

export const TierMapSchema = z.object({
  read: ApprovalTierSchema.optional(),
  write_in_scope: ApprovalTierSchema.optional(),
  validation: ApprovalTierSchema.optional(),
  write_out_of_scope: ApprovalTierSchema.optional(),
  destructive: ApprovalTierSchema.optional(),
  network: ApprovalTierSchema.optional(),
  package_change: ApprovalTierSchema.optional(),
});

export const ApprovalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  headless: z.boolean().optional(),
  tiers: TierMapSchema.optional(),
  feedRejectionsToPlanner: z.boolean().default(true),
  allowedPaths: z.array(z.string().min(1)).optional(),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

/**
 * v3 ConfigSchema. Accepts both `version: 2` and `version: 3` on input for
 * backward compatibility (see migration.md §2.3). Deprecated v2 fields
 * (`autoApproveSpec`, `autoApprovePlan`, top-level `commitStrategy`) remain
 * optional alongside their v3 replacements (`approve`, `git.commitStrategy`)
 * until briefs 04 and 07 retire the read sites.
 */
export const ConfigSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  planner: PlannerConfigSchema,
  implementer: ImplementerConfigSchema,
  implementerProfiles: ImplementerProfilesConfigSchema.optional(),
  validation: z.object({
    typecheck: z.boolean(),
    lint: z.boolean(),
    test: z.boolean(),
    testCommand: z.string().min(1).optional(),
    typecheckCommand: z.string().min(1).optional(),
    lintCommand: z.string().min(1).optional(),
    testPattern: z.string().min(1).optional(),
  }),
  workflow: z.object({
    autoApproveSpec: z.boolean().optional(),
    autoApprovePlan: z.boolean().optional(),
    approve: ApproveLevelSchema.optional(),
    maxRetries: z.number().int().min(0),
    commitStrategy: CommitStrategySchema.optional(),
    git: GitWorkflowConfigSchema.optional(),
    speckit: SpeckitWorkflowConfigSchema.optional(),
    mode: WorkflowModeSchema.optional(),
    briefReview: z.enum(['simple', 'rich']).optional(),
    taskReview: TaskReviewModeSchema.optional(),
    maxBudget: z.number().positive().optional(),
    budgetPauseThreshold: z.number().min(0).max(1).optional(),
    driftChainThreshold: z.number().min(0).max(1).optional(),
    costGate: z.boolean().optional(),
    persistTranscript: z.boolean().default(true),
    compactionThreshold: z.number().int().min(10).optional(),
    compactionFormat: CompactionFormatSchema.default('auto'),
  }),
  theme: ThemeModeSchema.optional(),
  shikiTheme: ShikiThemeSchema.optional(),
  sessions: z.object({
    scope: z.enum(['project', 'global']).optional(),
  }).optional(),
  escalation: EscalationConfigSchema.optional(),
  codebase: CodebaseConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  otel: OtelConfigSchema.optional(),
  snapshots: SnapshotsConfigSchema.optional(),
  palette: PaletteConfigSchema.optional(),
  approval: ApprovalConfigSchema.optional(),
  plannerEstimateReview: z.boolean().optional(),
  autoSplitOverflow: z.boolean().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_WORKFLOW_MODE = 'standard' as const;
