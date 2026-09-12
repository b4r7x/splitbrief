import { z } from 'zod';
import type { RunnerKind } from './enums.js';
import { GenerationCommonFields, createRunnerConfigSchema } from './runner-fields.js';
import { AUTO_CHEAPEST_MODEL, isAutoCheapestModel } from '../providers/automatic-model.js';

/**
 * Price routing derives its priced rows from the CLI catalogs the last readiness
 * pass remembered, so only a `cli` seat can carry the marker: an api, shell or
 * agent seat has no derivation to fall back on and would transmit `auto:cheapest`
 * as a literal model id. The refusal belongs at load, not at the first call.
 */
export const ImplementerConfigSchema = createRunnerConfigSchema(GenerationCommonFields).superRefine(
  (implementer, ctx) => {
    if (implementer.kind === 'cli' || !isAutoCheapestModel(implementer.model)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['model'],
      message: `model "${AUTO_CHEAPEST_MODEL}" routes a cli implementer seat to a priced model; a "${implementer.kind}" seat must name a concrete model`,
    });
  },
);

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
  /**
   * Blended price per 1M tokens the router ranks this profile by, finer than
   * `costTier`'s four buckets. Auto-cheapest derivation writes it from the
   * discovery snapshot; a hand-written profile may declare its own.
   */
  pricePer1M: z.number().finite().nonnegative().optional(),
})
  .superRefine((profile, ctx) => {
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
  })
  .superRefine((profile, ctx) => {
    if (!isAutoCheapestModel(profile.model)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['model'],
      message:
        'model "auto:cheapest" is the implementer seat\'s auto-routing marker; a profile must name a concrete model',
    });
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
