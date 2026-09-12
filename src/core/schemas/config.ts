import { z } from 'zod';
import {
  WorkflowModeSchema,
  CommitStrategySchema,
  ApproveLevelSchema,
  IsolationStrategySchema,
} from './enums.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ImplementerConfigSchema, ImplementerProfilesConfigSchema } from './implementer-config.js';
import { ReviewerConfigSchema } from './reviewer-config.js';
import { CodebaseConfigSchema } from './codebase.js';
import { HooksConfigSchema } from './hooks.js';
import { CompactionFormatSchema } from './compaction.js';
import { CustomCommandsConfigSchema } from '../config/custom-commands.js';

const PaletteCustomActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  command: z.string().startsWith('/'),
});

const PaletteConfigSchema = z.object({
  customActions: z.array(PaletteCustomActionSchema).optional(),
});

const EscalationConfigSchema = z
  .object({
    intermediateProvider: z.string().optional(),
    intermediateModel: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((escalation, ctx) => {
    if (escalation.intermediateProvider && !escalation.intermediateModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'intermediateModel is required when intermediateProvider is set',
        path: ['intermediateModel'],
      });
    }
  });

const GitWorkflowConfigSchema = z.strictObject({
  commitStrategy: CommitStrategySchema.optional(),
  createBranch: z.boolean().optional(),
});

export const TaskReviewModeSchema = z.enum(['none', 'failed', 'every']);
export type TaskReviewMode = z.infer<typeof TaskReviewModeSchema>;

const SpeckitWorkflowConfigSchema = z.strictObject({
  minCoverage: z.number().min(0).max(1).optional(),
});

export const ApprovalTierSchema = z.enum(['auto', 'sticky', 'confirm']);
export type ApprovalTier = z.infer<typeof ApprovalTierSchema>;

export const TierMapSchema = z.strictObject({
  read: ApprovalTierSchema.optional(),
  write_in_scope: ApprovalTierSchema.optional(),
  write_out_of_scope: ApprovalTierSchema.optional(),
  destructive: ApprovalTierSchema.optional(),
  package_change: ApprovalTierSchema.optional(),
});

export const ApprovalConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  tiers: TierMapSchema.optional(),
  feedRejectionsToPlanner: z.boolean().default(true),
  allowedPaths: z.array(z.string().min(1)).optional(),
});

export function defaultApprovalConfig(): z.infer<typeof ApprovalConfigSchema> {
  return ApprovalConfigSchema.parse({});
}

export const CONFIG_VERSION = 3;

export const ConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  customCommands: CustomCommandsConfigSchema.optional(),
  planner: PlannerConfigSchema,
  implementer: ImplementerConfigSchema,
  implementerProfiles: ImplementerProfilesConfigSchema.optional(),
  reviewer: ReviewerConfigSchema.optional(),
  validation: z.object({
    typecheck: z.boolean(),
    lint: z.boolean(),
    test: z.boolean(),
    testCommand: z.string().min(1).optional(),
    typecheckCommand: z.string().min(1).optional(),
    lintCommand: z.string().min(1).optional(),
    testPattern: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
  }),
  workflow: z.strictObject({
    approve: ApproveLevelSchema.optional(),
    maxRetries: z.number().int().min(0),
    git: GitWorkflowConfigSchema.optional(),
    isolation: IsolationStrategySchema.optional(),
    speckit: SpeckitWorkflowConfigSchema.optional(),
    mode: WorkflowModeSchema.optional(),
    briefReview: z.enum(['simple']).optional(),
    taskReview: TaskReviewModeSchema.optional(),
    maxBudget: z.number().positive().optional(),
    budgetPauseThreshold: z.number().min(0).max(1).optional(),
    driftChainThreshold: z.number().min(0).max(1).optional(),
    costGate: z.boolean().optional(),
    compactionThreshold: z.number().int().min(10).optional(),
    compactionFormat: CompactionFormatSchema.default('auto'),
  }),
  sessions: z
    .object({
      scope: z.enum(['project']).optional(),
    })
    .optional(),
  escalation: EscalationConfigSchema.optional(),
  codebase: CodebaseConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  palette: PaletteConfigSchema.optional(),
  approval: ApprovalConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_WORKFLOW_MODE = 'standard' as const;
