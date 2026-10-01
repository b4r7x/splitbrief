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
import { STACK_IDS } from '../validation/stacks/types.js';

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
    /**
     * The mid-tier worker, always an `api` runner. It names an API catalog provider
     * (`ollama`, `lm-studio`, `llama-cpp`) or a custom API provider; a custom name
     * reuses the API implementer's endpoint and inline key, with the configured name
     * as its identity. A CLI tool id here (`opencode`) is a custom provider of that
     * name, never the CLI tool.
     */
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

const GitWorkflowFieldsSchema = z.strictObject({
  commitStrategy: CommitStrategySchema.optional(),
  createBranch: z.boolean().optional(),
});

// `none` is what the removed automation already did, so it loads and is dropped; `checkpoint` and
// `per-task` asked SPLITBRIEF to write the git index, which it no longer does, so they fail the load.
const GitWorkflowConfigSchema = GitWorkflowFieldsSchema.superRefine((git, ctx) => {
  if (git.commitStrategy === undefined || git.commitStrategy === 'none') return;
  ctx.addIssue({
    code: 'custom',
    message: `commitStrategy "${git.commitStrategy}" was removed — SPLITBRIEF no longer stages, commits or checkpoints; delete workflow.git.commit_strategy and commit your changes yourself.`,
    path: ['commitStrategy'],
  });
}).transform(
  ({ commitStrategy: _retired, ...git }): z.infer<typeof GitWorkflowFieldsSchema> => git,
);

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
  sensitive_change: ApprovalTierSchema.optional(),
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
    stack: z.enum(STACK_IDS).optional(),
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
    driftChainThreshold: z.number().min(0).max(1).optional(),
    compactionThreshold: z.number().int().min(10).optional(),
    compactionFormat: CompactionFormatSchema.default('auto'),
    showSpend: z.boolean().optional(),
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
