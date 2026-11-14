import { z } from 'zod';
import {
  ApiRunnerFields,
  CliRunnerFields,
  GenerationCommonFields,
  IDLE_THRESHOLD_ORDER,
  RUNNER_DESCRIPTORS,
  SeatFallbackField,
  apiProviderSchemaForSeat,
  idleThresholdsOrdered,
  removedCliToolGuard,
} from './fields.js';
import { PLANNER_CLI_TOOL_IDS } from '../../runners/cli-tool/catalog.js';
import { PlannerCliToolIdSchema, type RunnerKind } from '../enums.js';
import type { PlannerTierRole } from '../../runners/seat-roles.js';
import {
  validateAutomaticModelResolvable,
  validateCliModelPolicy,
  validateRemovedApiProvider,
  validateApiIdentity,
  validateOllamaLocalCredential,
  validateFallback,
} from './refinements.js';

const PlannerCapabilitiesSchema = z.strictObject({
  supportsConversationalPlanning: z.boolean(),
  supportsSessionResume: z.boolean(),
  supportsEffort: z.boolean(),
  supportsImages: z.boolean(),
  supportsSelfSummarisation: z.boolean(),
});

const PlannerCliRunnerFields = {
  ...CliRunnerFields,
  tool: removedCliToolGuard(PLANNER_CLI_TOOL_IDS).pipe(PlannerCliToolIdSchema),
};

const PlannerCapabilitiesPartialSchema = PlannerCapabilitiesSchema.partial();

const PlannerCapabilitiesField = {
  capabilities: PlannerCapabilitiesPartialSchema.optional(),
};

export function createPlannerConfigSchema<C extends z.ZodRawShape>(
  commonFields: C,
  seat: PlannerTierRole = 'planner',
) {
  const { model: _configuredModel, ...cliCommonFields } = commonFields;
  const cliBranchFields = {
    ...cliCommonFields,
    ...PlannerCliRunnerFields,
    model: z.string().min(1).optional(),
  };
  const cliSeat = z
    .strictObject(cliBranchFields)
    .superRefine((input, ctx) => {
      validateAutomaticModelResolvable(input, ctx);
      validateCliModelPolicy('planner', input, ctx);
    })
    .refine(idleThresholdsOrdered, IDLE_THRESHOLD_ORDER);
  return z
    .discriminatedUnion('kind', [
      z.strictObject({ ...cliBranchFields, ...SeatFallbackField }),
      z.strictObject({
        ...commonFields,
        ...ApiRunnerFields,
        provider: apiProviderSchemaForSeat(seat),
        ...SeatFallbackField,
      }),
      z.strictObject({
        ...commonFields,
        ...RUNNER_DESCRIPTORS.shell.fields,
        ...PlannerCapabilitiesField,
        ...SeatFallbackField,
      }),
      z.strictObject({
        ...commonFields,
        ...RUNNER_DESCRIPTORS.agent.fields,
        ...PlannerCapabilitiesField,
        ...SeatFallbackField,
      }),
    ])
    .superRefine((input, ctx) => {
      validateRemovedApiProvider(input, ctx);
      validateApiIdentity(input, ctx);
      validateOllamaLocalCredential(input, ctx);
      validateAutomaticModelResolvable(input, ctx);
      validateCliModelPolicy('planner', input, ctx);
      validateFallback(cliSeat, input, ctx);
    })
    .refine(idleThresholdsOrdered, IDLE_THRESHOLD_ORDER);
}

const COMMAND_KIND_UNSUPPORTED_CAPABILITIES = [
  ['supportsSessionResume', 'has no documented command session-handle contract'],
  ['supportsEffort', 'has no channel to deliver an effort hint to the command'],
  ['supportsImages', 'has no channel to deliver image attachments to the command'],
] as const;

type CommandSeatRunner = Readonly<{
  kind: RunnerKind;
  capabilities?: z.infer<typeof PlannerCapabilitiesPartialSchema> | undefined;
}>;

export function commandKindCapabilityGuard(seatLabel: PlannerTierRole) {
  return (cfg: CommandSeatRunner, ctx: z.RefinementCtx): void => {
    if (cfg.kind !== 'shell' && cfg.kind !== 'agent') return;
    for (const [capability, reason] of COMMAND_KIND_UNSUPPORTED_CAPABILITIES) {
      if (cfg.capabilities?.[capability] !== true) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', capability],
        message: `Runner kind "${cfg.kind}" ${reason}; remove ${capability} or use a cli/api ${seatLabel}`,
      });
    }
  };
}

export const PlannerConfigSchema = createPlannerConfigSchema({
  ...GenerationCommonFields,
  model: z.string().min(1).optional(),
}).superRefine(commandKindCapabilityGuard('planner'));

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
export type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
export type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
export type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
