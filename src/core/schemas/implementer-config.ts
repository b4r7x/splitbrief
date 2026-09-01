import { z } from 'zod';
import type { RunnerKind } from './enums.js';
import { GenerationCommonFields, createRunnerConfigSchema } from './runner-fields.js';

export const ImplementerConfigSchema = createRunnerConfigSchema(GenerationCommonFields);

export const ImplementerCostTierSchema = z.enum([
  'local',
  'cheap',
  'standard',
  'frontier',
  'unknown',
]);

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
  costTier: ImplementerCostTierSchema.optional(),
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
export type ImplementerCostTier = z.infer<typeof ImplementerCostTierSchema>;
export type ImplementerWriteMode = z.infer<typeof ImplementerWriteModeSchema>;
export type ImplementerCapabilities = z.infer<typeof ImplementerCapabilitiesSchema>;
export type ImplementerProfileConfig = z.infer<typeof ImplementerProfileConfigSchema>;
export type ImplementerProfilesConfig = z.infer<typeof ImplementerProfilesConfigSchema>;

export type CliImplementerConfig = Extract<ImplementerConfig, { kind: 'cli' }>;
export type ApiImplementerConfig = Extract<ImplementerConfig, { kind: 'api' }>;
export type ShellImplementerConfig = Extract<ImplementerConfig, { kind: 'shell' }>;
export type AgentImplementerConfig = Extract<ImplementerConfig, { kind: 'agent' }>;
