import { z } from 'zod';
import { CommitStrategySchema, ApproveLevelSchema, IsolationStrategySchema } from './enums.js';
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

export const ApprovalConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Retired: loads with one notice and changes nothing. */
  tiers: z.unknown().optional(),
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
    review: z.enum(['end', 'task']).optional(),
    /** Retired: loads with one notice and changes nothing. */
    maxRetries: z.unknown().optional(),
    git: GitWorkflowConfigSchema.optional(),
    isolation: IsolationStrategySchema.optional(),
    /** Retired: loads with one notice and changes nothing. */
    speckit: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    mode: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    briefReview: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    taskReview: z.unknown().optional(),
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
  /** Retired: loads with one notice and changes nothing. */
  escalation: z.unknown().optional(),
  codebase: CodebaseConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  palette: PaletteConfigSchema.optional(),
  approval: ApprovalConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
