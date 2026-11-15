import { z } from 'zod';
import { KNOWN_API_PROVIDER_IDS } from '../../providers/api-catalog.js';
import { CliToolIdSchema } from '../../schemas/enums.js';
import { CliProviderAuthSchema } from './auth.js';
import { CliExecutableIdentitySchema } from './executable.js';
import { DetectedModelSchema } from './model.js';

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

export const CliTrustStateSchema = z.enum(['trusted', 'untrusted', 'not-checked']);
export type CliTrustState = z.infer<typeof CliTrustStateSchema>;

export const CliCompatibilityStateSchema = z.enum([
  'compatible',
  'incompatible',
  'unverified',
  'timeout',
  'not-checked',
]);
export type CliCompatibilityState = z.infer<typeof CliCompatibilityStateSchema>;

export const CliAuthStateSchema = z.enum([
  'authenticated',
  'unauthenticated',
  'keyring',
  'unknown',
  'timeout',
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
    /** Absent only for a tool with no credential oracle to read. */
    providerAuth: CliProviderAuthSchema.optional(),
    /**
     * The model the tool selects in its own config or state on this host. Read only for a tool that
     * stores no credential, whose seat on `auto` or with no model is ready on that model's route.
     */
    selectedModel: z.string().min(1).optional(),
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
