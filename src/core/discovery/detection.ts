import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { KNOWN_API_PROVIDER_IDS } from '../providers/api-provider-catalog.js';
import { CliToolIdSchema } from '../schemas/enums.js';

const OptionalPriceSchema = z.number().finite().nonnegative().optional();

export const DetectedPricingProvenanceSchema = z
  .object({
    asOf: z.iso.date(),
    source: z.string().trim().min(1).max(2_048),
  })
  .strict();
export type DetectedPricingProvenance = z.infer<typeof DetectedPricingProvenanceSchema>;

export const DetectedPricingTierSchema = z
  .object({
    type: z.literal('context'),
    thresholdTokens: z.number().int().nonnegative(),
    inputPer1M: OptionalPriceSchema,
    outputPer1M: OptionalPriceSchema,
    cacheReadPer1M: OptionalPriceSchema,
    cacheWritePer1M: OptionalPriceSchema,
  })
  .strict();
export type DetectedPricingTier = z.infer<typeof DetectedPricingTierSchema>;

export const DetectedModelSchema = z
  .object({
    id: z.string().min(1),
    contextLength: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    pricingInput: OptionalPriceSchema,
    pricingOutput: OptionalPriceSchema,
    pricingCacheRead: OptionalPriceSchema,
    pricingCacheWrite: OptionalPriceSchema,
    pricingTiers: z.array(DetectedPricingTierSchema).optional(),
    pricingProvenance: DetectedPricingProvenanceSchema.optional(),
    isFree: z.boolean().optional(),
    supportsTemperature: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    releaseDate: z.string().optional(),
  })
  .strict();
export type DetectedModel = z.infer<typeof DetectedModelSchema>;

export const CLI_READINESS_STATES = [
  'ready',
  'unavailable',
  'untrusted',
  'unauthenticated',
  'incompatible',
  'unverified',
  'disabled',
] as const;
export const CliReadinessStateSchema = z.enum(CLI_READINESS_STATES);
export type CliReadinessState = z.infer<typeof CliReadinessStateSchema>;

export const NON_READY_CLI_READINESS_STATES = Object.freeze(
  CLI_READINESS_STATES.filter(
    (state): state is Exclude<CliReadinessState, 'ready'> => state !== 'ready',
  ),
);

export const CliExecutableIdentitySchema = z
  .object({
    path: z.string().min(1).refine(isAbsolute, 'Executable path must be absolute'),
    fingerprint: z
      .object({
        dev: z.number().int().nonnegative(),
        ino: z.number().int().nonnegative(),
        size: z.number().int().nonnegative(),
        mtimeMs: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type CliExecutableIdentity = z.infer<typeof CliExecutableIdentitySchema>;

export const CliTrustStateSchema = z.enum(['trusted', 'untrusted', 'not-checked']);
export type CliTrustState = z.infer<typeof CliTrustStateSchema>;

export const CliCompatibilityStateSchema = z.enum([
  'compatible',
  'incompatible',
  'unverified',
  'not-checked',
]);
export type CliCompatibilityState = z.infer<typeof CliCompatibilityStateSchema>;

export const CliAuthStateSchema = z.enum([
  'authenticated',
  'unauthenticated',
  'unknown',
  'not-required',
  'not-checked',
]);
export type CliAuthState = z.infer<typeof CliAuthStateSchema>;

const CliReadyDiagnosticSchema = z
  .object({
    state: z.literal('ready'),
    remediation: z.null(),
  })
  .strict();

const RemediationSchema = z.string().min(1).max(4_000);
const CliBlockedDiagnosticSchema = z
  .object({
    state: z.enum(NON_READY_CLI_READINESS_STATES),
    remediation: RemediationSchema,
  })
  .strict();

export const CliDiagnosticSchema = z.union([CliReadyDiagnosticSchema, CliBlockedDiagnosticSchema]);
export type CliDiagnostic = z.infer<typeof CliDiagnosticSchema>;

export const CliToolDetectionSchema = z
  .object({
    tool: CliToolIdSchema,
    executable: CliExecutableIdentitySchema.nullable(),
    trust: CliTrustStateSchema,
    installedVersion: z.string().min(1).nullable(),
    testedVersion: z.string().min(1),
    compatibility: CliCompatibilityStateSchema,
    auth: CliAuthStateSchema,
    diagnostic: CliDiagnosticSchema,
    probedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((detection, ctx) => {
    if (
      detection.diagnostic.state === 'ready' &&
      (detection.trust !== 'trusted' ||
        detection.compatibility !== 'compatible' ||
        (detection.auth !== 'authenticated' && detection.auth !== 'not-required'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['diagnostic', 'state'],
        message:
          'Ready diagnostic requires trusted, compatible, and authenticated or not-required facts',
      });
    }
  });
export type CliToolDetection = z.infer<typeof CliToolDetectionSchema>;

export const ProviderDetectionSchema = z
  .object({
    provider: z.enum(KNOWN_API_PROVIDER_IDS),
    available: z.boolean(),
    models: z.array(DetectedModelSchema).optional(),
    isLocal: z.boolean(),
    hasKey: z.boolean().optional(),
    error: z.string().optional(),
  })
  .strict();
export type ProviderDetection = z.infer<typeof ProviderDetectionSchema>;
