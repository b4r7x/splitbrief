import { z } from 'zod';
import {
  WorkflowModeSchema,
  CommitStrategySchema,
  ApproveLevelSchema,
  ThemeModeSchema,
  SessionScopeSchema,
} from './enums.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ImplementerConfigSchema, ImplementerProfilesConfigSchema } from './implementer-config.js';
import { CodebaseConfigSchema } from './codebase.js';
import { HooksConfigSchema } from './hooks.js';
import { OtelConfigSchema } from './otel.js';
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

const SnapshotsAutoConfigSchema = z.object({
  preTask: z.boolean().optional(),
  postTask: z.boolean().optional(),
  preFinalReview: z.boolean().optional(),
});

const SnapshotsConfigSchema = z.object({
  auto: SnapshotsAutoConfigSchema.optional(),
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
  sessions: z
    .object({
      scope: SessionScopeSchema.optional(),
    })
    .optional(),
  escalation: EscalationConfigSchema.optional(),
  codebase: CodebaseConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  otel: OtelConfigSchema.optional(),
  snapshots: SnapshotsConfigSchema.optional(),
  palette: PaletteConfigSchema.optional(),
  trust: z
    .object({
      customRenderers: z.boolean().default(false),
    })
    .optional(),
  approval: ApprovalConfigSchema.optional(),
  plannerEstimateReview: z.boolean().optional(),
  autoSplitOverflow: z.boolean().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_WORKFLOW_MODE = 'standard' as const;
