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
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    lifecycle: z.string().min(1).optional(),
    releaseDate: z.string().optional(),
    updatedDate: z.string().optional(),
    maximumContextTokens: z.number().int().positive().optional(),
    effectiveContextTokens: z.number().int().positive().optional(),
    maximumInputTokens: z.number().int().positive().optional(),
    maximumOutputTokens: z.number().int().positive().optional(),
    inputModalities: z.array(z.string().min(1)).readonly().optional(),
    outputModalities: z.array(z.string().min(1)).readonly().optional(),
    supportsToolCalls: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
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
    nativeOrder: z.number().int().nonnegative().optional(),
    nativeDefault: z.boolean().optional(),
    nativeHidden: z.boolean().optional(),
    nativeReasoningEfforts: z.array(z.string().trim().min(1)).readonly().optional(),
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

export const EXECUTABLE_CONTENT_DIGEST_ALGORITHM = 'sha256';
const EXECUTABLE_CONTENT_DIGEST_HEX_LENGTH = 64;

const AbsoluteExecutablePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'Executable path must be absolute');

export const CliExecutableFingerprintSchema = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().finite().nonnegative(),
  })
  .strict();
export type CliExecutableFingerprint = z.infer<typeof CliExecutableFingerprintSchema>;

export const CliExecutableIdentitySchema = z
  .object({
    path: AbsoluteExecutablePathSchema,
    fingerprint: CliExecutableFingerprintSchema,
  })
  .strict();
export type CliExecutableIdentity = z.infer<typeof CliExecutableIdentitySchema>;

export function parseDigestBoundExecutableFingerprint(
  value: string,
): CliExecutableFingerprint | null {
  const parts = value.split(':');
  if (parts.length !== 6) return null;
  const [dev, ino, size, mtimeMs, algorithm, contentDigest] = parts;
  if (
    dev === undefined ||
    ino === undefined ||
    size === undefined ||
    mtimeMs === undefined ||
    algorithm !== EXECUTABLE_CONTENT_DIGEST_ALGORITHM ||
    contentDigest === undefined ||
    contentDigest.length !== EXECUTABLE_CONTENT_DIGEST_HEX_LENGTH ||
    !/^[a-f0-9]+$/.test(contentDigest)
  ) {
    return null;
  }

  const parsedDev = nonnegativeInteger(dev);
  const parsedIno = nonnegativeInteger(ino);
  const parsedSize = nonnegativeInteger(size);
  const parsedMtimeMs = nonnegativeNumber(mtimeMs);
  if (parsedDev === null || parsedIno === null || parsedSize === null || parsedMtimeMs === null) {
    return null;
  }
  return { dev: parsedDev, ino: parsedIno, size: parsedSize, mtimeMs: parsedMtimeMs };
}

function nonnegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonnegativeNumber(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const DigestBoundExecutableFingerprintSchema = z.string().superRefine((value, ctx) => {
  if (parseDigestBoundExecutableFingerprint(value) !== null) return;
  ctx.addIssue({
    code: 'custom',
    message: 'Executable fingerprint must bind stat metadata to a SHA-256 content digest',
  });
});

export function formatDigestBoundExecutableFingerprint(
  input: Readonly<{ fingerprint: CliExecutableFingerprint; contentDigest: string }>,
): string | null {
  const { fingerprint, contentDigest } = input;
  const value = `${fingerprint.dev}:${fingerprint.ino}:${fingerprint.size}:${fingerprint.mtimeMs}:${EXECUTABLE_CONTENT_DIGEST_ALGORITHM}:${contentDigest}`;
  const result = DigestBoundExecutableFingerprintSchema.safeParse(value);
  return result.success ? result.data : null;
}

export const ExecutableIdentitySchema = z
  .object({
    canonicalPath: AbsoluteExecutablePathSchema,
    realPath: AbsoluteExecutablePathSchema,
    platformFileId: z.string().min(1),
    fingerprint: DigestBoundExecutableFingerprintSchema,
    resolvedAt: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((identity, ctx) => {
    const fingerprint = parseDigestBoundExecutableFingerprint(identity.fingerprint);
    if (fingerprint === null) return;
    if (identity.platformFileId === `${fingerprint.dev}:${fingerprint.ino}`) return;
    ctx.addIssue({
      code: 'custom',
      path: ['platformFileId'],
      message: 'Executable platform file ID must match the digest-bound fingerprint',
    });
  });
export type ExecutableIdentity = z.infer<typeof ExecutableIdentitySchema>;

export const CliExecutableReceiptSchema = z
  .object({
    path: AbsoluteExecutablePathSchema,
    fingerprint: CliExecutableFingerprintSchema,
    executableIdentity: ExecutableIdentitySchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const richFingerprint = parseDigestBoundExecutableFingerprint(
      receipt.executableIdentity.fingerprint,
    );
    if (receipt.path !== receipt.executableIdentity.realPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Executable receipt path must match its real path',
      });
    }
    if (
      richFingerprint !== null &&
      (receipt.fingerprint.dev !== richFingerprint.dev ||
        receipt.fingerprint.ino !== richFingerprint.ino ||
        receipt.fingerprint.size !== richFingerprint.size ||
        receipt.fingerprint.mtimeMs !== richFingerprint.mtimeMs)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['fingerprint'],
        message: 'Executable receipt stat fingerprint must match its digest-bound fingerprint',
      });
    }
  });
export type CliExecutableReceipt = z.infer<typeof CliExecutableReceiptSchema>;

export const CliExecutableTrustSchema = z.union([
  CliExecutableReceiptSchema,
  CliExecutableIdentitySchema,
]);
export type CliExecutableTrust = z.infer<typeof CliExecutableTrustSchema>;

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

/**
 * One per-provider authentication fact reported by a CLI's own credential
 * listing. Carries only the provider display name, the source kind, and (for
 * environment entries) the env var name — never a credential value.
 */
export const CliProviderAuthFactSchema = z
  .object({
    provider: z.string().min(1).max(200),
    source: z.enum(['oauth', 'api', 'env']),
    envVar: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CliProviderAuthFact = z.infer<typeof CliProviderAuthFactSchema>;

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

/**
 * Legacy presentation wire contract. Convert it to `RunnerEvidence` before
 * deriving status; it is never an authorization input for workflow start.
 */
export const CliToolDetectionSchema = z
  .object({
    tool: CliToolIdSchema,
    executable: CliExecutableIdentitySchema.nullable(),
    trust: CliTrustStateSchema,
    installedVersion: z.string().min(1).nullable(),
    testedVersion: z.string().min(1),
    compatibility: CliCompatibilityStateSchema,
    auth: CliAuthStateSchema,
    /** Absent on payloads cached before it existed and whenever no oracle ran. */
    providerAuth: z.array(CliProviderAuthFactSchema).max(64).readonly().optional(),
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

/**
 * Mirrors the engine's provider catalog failure kinds
 * (PROVIDER_CATALOG_FAILURE_KINDS in src/engine/providers/types.ts); core
 * cannot import engine. providerDetectionFromOutcome assigns the engine kind
 * to this type, so a divergence fails the typecheck there.
 */
export const PROVIDER_DETECTION_FAILURE_KINDS = [
  'endpoint-invalid',
  'missing-credential',
  'invalid-credential',
  'policy-denied',
  'privacy-filtered',
  'guardrail-filtered',
  'offline',
  'timeout',
  'malformed',
  'request-failed',
] as const;
export const ProviderDetectionFailureKindSchema = z.enum(PROVIDER_DETECTION_FAILURE_KINDS);

/**
 * Legacy presentation wire contract. Its `available` and `hasKey` fields do
 * not independently authorize workflow start. `failure` is absent on payloads
 * cached before it existed; consumers treat undefined as unknown.
 */
export const ProviderDetectionSchema = z
  .object({
    provider: z.enum(KNOWN_API_PROVIDER_IDS),
    available: z.boolean(),
    models: z.array(DetectedModelSchema).optional(),
    isLocal: z.boolean(),
    hasKey: z.boolean().optional(),
    failure: ProviderDetectionFailureKindSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type ProviderDetection = z.infer<typeof ProviderDetectionSchema>;
