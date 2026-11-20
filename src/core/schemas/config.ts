import { z } from 'zod';
import { CommitStrategySchema, ApproveLevelSchema, IsolationStrategySchema } from './enums.js';
import { PlannerConfigSchema } from './runner/planner.js';
import { ImplementerConfigSchema, ImplementerProfilesConfigSchema } from './runner/implementer.js';
import { ReviewerConfigSchema } from './runner/reviewer.js';
import { HooksConfigSchema } from './hooks.js';
import { CompactionFormatSchema } from './compaction.js';
import { CustomCommandsConfigSchema } from '../config/custom-commands/schema.js';
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

// Both fields are retired. `commitStrategy: none` and `createBranch: false` are what SPLITBRIEF
// already does, so they load and are dropped; `checkpoint`, `per-task` and `createBranch: true`
// asked for git writes SPLITBRIEF no longer makes, so they fail the load.
const GitWorkflowConfigSchema = GitWorkflowFieldsSchema.superRefine((git, ctx) => {
  if (git.commitStrategy !== undefined && git.commitStrategy !== 'none') {
    ctx.addIssue({
      code: 'custom',
      message: `commitStrategy "${git.commitStrategy}" was removed — SPLITBRIEF no longer stages, commits or checkpoints; delete workflow.git.commit_strategy and commit your changes yourself.`,
      path: ['commitStrategy'],
    });
  }
  if (git.createBranch === true) {
    ctx.addIssue({
      code: 'custom',
      message:
        'createBranch was removed — SPLITBRIEF no longer creates a branch; delete workflow.git.create_branch and create your branch yourself.',
      path: ['createBranch'],
    });
  }
}).transform((): z.infer<typeof GitWorkflowFieldsSchema> => ({}));

export const ApprovalConfigSchema = z.strictObject({
  /** Retired: loads with one notice and changes nothing. */
  enabled: z.unknown().optional(),
  /** Retired: loads with one notice and changes nothing. */
  tiers: z.unknown().optional(),
  feedRejectionsToPlanner: z.boolean().default(true),
  allowedPaths: z.array(z.string().min(1)).optional(),
});

export const CONFIG_VERSION = 3;

export const ConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  customCommands: CustomCommandsConfigSchema.optional(),
  planner: PlannerConfigSchema,
  implementer: ImplementerConfigSchema,
  implementerProfiles: ImplementerProfilesConfigSchema.optional(),
  reviewer: z.union([z.literal('none'), ReviewerConfigSchema]).optional(),
  validation: z.object({
    /** SPLITBRIEF runs the project gate the plan names before the final review; on when unset. */
    endChecks: z.boolean().optional(),
    /** Retired: loads with one notice and changes nothing. */
    approveChecks: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    typecheck: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    lint: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    test: z.unknown().optional(),
    testCommand: z.string().min(1).optional(),
    /** Retired: loads with one notice and changes nothing. */
    typecheckCommand: z.unknown().optional(),
    /** Retired: loads with one notice and changes nothing. */
    lintCommand: z.unknown().optional(),
    testPattern: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    stack: z.enum(STACK_IDS).optional(),
    render: z.string().min(1).optional(),
  }),
  workflow: z
    .strictObject({
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
      /** Retired: loads with one notice and changes nothing. */
      driftChainThreshold: z.unknown().optional(),
      compactionThreshold: z.number().int().min(10).optional(),
      compactionFormat: CompactionFormatSchema.default('auto'),
      showSpend: z.unknown().optional(),
    })
    .transform(({ showSpend: _showSpend, ...workflow }) => workflow),
  sessions: z
    .object({
      scope: z.enum(['project']).optional(),
    })
    .optional(),
  /** Retired: loads with one notice and changes nothing. */
  escalation: z.unknown().optional(),
  hooks: HooksConfigSchema.optional(),
  palette: PaletteConfigSchema.optional(),
  approval: ApprovalConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
