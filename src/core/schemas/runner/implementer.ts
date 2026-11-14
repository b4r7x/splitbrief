import { z } from 'zod';
import { ImplementerCliToolIdSchema, type RunnerKind } from '../enums.js';
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
import { IMPLEMENTER_CLI_TOOL_IDS } from '../../runners/cli-tool/catalog.js';
import {
  validateAutomaticModelResolvable,
  validateCliModelPolicy,
  validateRemovedApiProvider,
  validateApiIdentity,
  validateOllamaLocalCredential,
  validateFallback,
} from './refinements.js';

export const ImplementerCliRunnerFields = {
  ...CliRunnerFields,
  tool: removedCliToolGuard(IMPLEMENTER_CLI_TOOL_IDS).pipe(ImplementerCliToolIdSchema),
};

export const ImplementerApiRunnerFields = {
  ...ApiRunnerFields,
  provider: apiProviderSchemaForSeat('implementer'),
};

export function createRunnerConfigSchema<C extends z.ZodRawShape>(commonFields: C) {
  const { model: _requiredModel, ...cliCommonFields } = commonFields;
  const cliBranchFields = {
    ...cliCommonFields,
    ...ImplementerCliRunnerFields,
    model: z.string().min(1).optional(),
  };
  const cliSeat = z
    .strictObject(cliBranchFields)
    .superRefine((input, ctx) => {
      validateAutomaticModelResolvable(input, ctx);
      validateCliModelPolicy('implementer', input, ctx);
    })
    .refine(idleThresholdsOrdered, IDLE_THRESHOLD_ORDER);
  return z
    .discriminatedUnion('kind', [
      z.strictObject({ ...cliBranchFields, ...SeatFallbackField }),
      z.strictObject({ ...commonFields, ...ImplementerApiRunnerFields, ...SeatFallbackField }),
      z.strictObject({ ...commonFields, ...RUNNER_DESCRIPTORS.shell.fields, ...SeatFallbackField }),
      z.strictObject({ ...commonFields, ...RUNNER_DESCRIPTORS.agent.fields, ...SeatFallbackField }),
    ])
    .superRefine((input, ctx) => {
      validateRemovedApiProvider(input, ctx);
      validateApiIdentity(input, ctx);
      validateOllamaLocalCredential(input, ctx);
      validateAutomaticModelResolvable(input, ctx);
      validateCliModelPolicy('implementer', input, ctx);
      validateFallback(cliSeat, input, ctx);
    })
    .refine(idleThresholdsOrdered, IDLE_THRESHOLD_ORDER);
}

export const ImplementerConfigSchema = createRunnerConfigSchema(GenerationCommonFields);

export const ImplementerProfileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, numbers, and hyphens; start with a letter');

export const ImplementerWriteModeSchema = z.enum(['extracted-code', 'direct']);

export const ImplementerCapabilitiesSchema = z.strictObject({
  writesFiles: ImplementerWriteModeSchema.optional(),
});

export function defaultImplementerWriteMode(kind: RunnerKind): ImplementerWriteMode {
  return kind === 'api' || kind === 'shell' ? 'extracted-code' : 'direct';
}

export const ImplementerProfileConfigSchema = createRunnerConfigSchema({
  ...GenerationCommonFields,
  label: z.string().min(1).optional(),
  capabilities: ImplementerCapabilitiesSchema.optional(),
}).superRefine((profile, ctx) => {
  const writesFiles = profile.capabilities?.writesFiles;
  if (writesFiles === undefined) return;

  const expected = defaultImplementerWriteMode(profile.kind);
  if (writesFiles !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', 'writesFiles'],
      message: `Runner kind "${profile.kind}" writes files via "${expected}"`,
    });
  }
});

export const ImplementerProfilesConfigSchema = z
  .object({
    default: ImplementerProfileNameSchema.optional(),
    profiles: z.record(ImplementerProfileNameSchema, ImplementerProfileConfigSchema),
  })
  .superRefine((value, ctx) => {
    const profileNames = Object.keys(value.profiles);
    if (profileNames.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['profiles'],
        message: 'Define at least one implementer profile',
      });
    }
    if (value.default !== undefined && !profileNames.includes(value.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `Default implementer profile "${value.default}" is not defined`,
      });
    }
  });

export type ImplementerConfig = z.infer<typeof ImplementerConfigSchema>;
export type ImplementerWriteMode = z.infer<typeof ImplementerWriteModeSchema>;
export type ImplementerCapabilities = z.infer<typeof ImplementerCapabilitiesSchema>;
export type ImplementerProfileConfig = z.infer<typeof ImplementerProfileConfigSchema>;
export type ImplementerProfilesConfig = z.infer<typeof ImplementerProfilesConfigSchema>;

export type CliImplementerConfig = Extract<ImplementerConfig, { kind: 'cli' }>;
export type ApiImplementerConfig = Extract<ImplementerConfig, { kind: 'api' }>;
export type ShellImplementerConfig = Extract<ImplementerConfig, { kind: 'shell' }>;
export type AgentImplementerConfig = Extract<ImplementerConfig, { kind: 'agent' }>;
