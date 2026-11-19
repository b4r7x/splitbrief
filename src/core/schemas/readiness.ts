import { z } from 'zod';
import {
  CliAuthStateSchema,
  CliCompatibilityStateSchema,
  type CliReadinessStateSchema,
  CliTrustStateSchema,
  NON_READY_CLI_READINESS_STATES,
} from '../discovery/detection/tool.js';
import { CliProviderAuthSchema } from '../discovery/detection/auth.js';
import { CliExecutableIdentitySchema } from '../discovery/detection/executable.js';
import { signInOutranksUnreadVersion } from '../runners/cli-tool/catalog.js';
import { CliToolIdSchema } from './enums.js';

export const READINESS_SEVERITIES = ['ok', 'info', 'warning', 'blocker'] as const;
export const ReadinessSeveritySchema = z.enum(READINESS_SEVERITIES);
export type ReadinessSeverity = z.infer<typeof ReadinessSeveritySchema>;

export const READINESS_STATUSES = ['ready', 'ready-with-warnings', 'blocked'] as const;
export const ReadinessStatusSchema = z.enum(READINESS_STATUSES);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

export const READINESS_NEXT_ACTION_KINDS = [
  'continue',
  'run-init',
  'fix-config',
  'prepare-runner',
  'clean-or-isolate-repo',
  'raise-context',
  'exit',
] as const;
export const ReadinessNextActionKindSchema = z.enum(READINESS_NEXT_ACTION_KINDS);
export type ReadinessNextActionKind = z.infer<typeof ReadinessNextActionKindSchema>;

export const READINESS_DIAGNOSTIC_STATE_IDS = [
  'missing-binary',
  'untrusted-path',
  'incompatible-version',
  'version-timeout',
  'unauthenticated',
  'auth-unknown',
  'auth-timeout',
  'auth-offline',
  'auth-malformed',
  'auth-policy-denied',
  'endpoint-invalid',
  'credential-family-mismatch',
  'protocol-failure',
  'quota-rate-limit',
  'conflicting-args',
] as const;
export type ReadinessDiagnosticStateId = (typeof READINESS_DIAGNOSTIC_STATE_IDS)[number];

export const READINESS_MODEL_SELECTIONS = ['auto', 'explicit', 'unset'] as const;
export type ReadinessModelSelection = (typeof READINESS_MODEL_SELECTIONS)[number];

export type ReadinessMetadata =
  | string
  | number
  | boolean
  | null
  | ReadinessMetadata[]
  | { [key: string]: ReadinessMetadata };

export const ReadinessMetadataSchema: z.ZodType<ReadinessMetadata> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ReadinessMetadataSchema),
    z.record(z.string(), ReadinessMetadataSchema),
  ]),
);

export const StartReadinessCheckSchema = z.object({
  id: z.string(),
  severity: ReadinessSeveritySchema,
  summary: z.string(),
  details: z.array(z.string()).optional(),
  remediation: z.string().optional(),
});

export const CheckoutStartNoticeSchema = z.object({
  summary: z.string(),
  details: z.array(z.string()),
});
export type CheckoutStartNotice = z.infer<typeof CheckoutStartNoticeSchema>;

export const StartReadinessRecordSchema = z.object({
  type: z.literal('start-readiness'),
  generatedAt: z.string(),
  status: ReadinessStatusSchema,
  nextAction: ReadinessNextActionKindSchema,
  blockerCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  checks: z.array(StartReadinessCheckSchema),
});
export type StartReadinessRecord = z.infer<typeof StartReadinessRecordSchema>;

export const CliInstallationStateSchema = z.enum(['installed', 'unavailable']);
export type CliInstallationState = z.infer<typeof CliInstallationStateSchema>;

export const CliReadinessFactsSchema = z
  .object({
    tool: CliToolIdSchema,
    enabled: z.boolean(),
    installation: CliInstallationStateSchema,
    executable: CliExecutableIdentitySchema.nullable(),
    trust: CliTrustStateSchema,
    installedVersion: z.string().min(1).nullable(),
    testedVersion: z.string().min(1),
    compatibility: CliCompatibilityStateSchema,
    auth: CliAuthStateSchema,
    /** What the tool's credential oracle said; absent when it has none. */
    providerAuth: CliProviderAuthSchema.optional(),
    probedAt: z.number().int().nonnegative(),
  })
  .strict();
export type CliReadinessFacts = z.infer<typeof CliReadinessFactsSchema>;

const CliReadinessRemediationSchema = z.string().min(1).max(4_000);

const CliReadinessReadyResultSchema = z
  .object({
    ...CliReadinessFactsSchema.shape,
    checkId: z.string().min(1),
    status: z.literal('ready'),
    remediation: z.null(),
  })
  .strict();

const CliReadinessNonReadyResultSchema = z
  .object({
    ...CliReadinessFactsSchema.shape,
    checkId: z.string().min(1),
    status: z.enum(NON_READY_CLI_READINESS_STATES),
    remediation: CliReadinessRemediationSchema,
  })
  .strict();

const CliReadinessResultBaseSchema = z.union([
  CliReadinessReadyResultSchema,
  CliReadinessNonReadyResultSchema,
]);

export const CliReadinessResultSchema = CliReadinessResultBaseSchema.superRefine((result, ctx) => {
  const expected = deriveCliReadinessStatus(result);
  if (result.status !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: `CLI readiness status must be ${expected} for these facts`,
    });
  }
  const checkId = cliReadinessCheckId(result.tool);
  if (result.checkId !== checkId) {
    ctx.addIssue({
      code: 'custom',
      path: ['checkId'],
      message: `CLI readiness check ID must be ${checkId}`,
    });
  }
});
export type CliReadinessResult = z.infer<typeof CliReadinessResultSchema>;

export function cliReadinessCheckId(tool: CliReadinessFacts['tool']): string {
  return `runners.cli.${tool}.readiness`;
}

export function deriveCliReadinessStatus(
  facts: CliReadinessFacts,
): z.infer<typeof CliReadinessStateSchema> {
  if (!facts.enabled) return 'disabled';
  if (facts.installation === 'unavailable' || facts.executable === null) return 'unavailable';
  if (facts.trust !== 'trusted') return 'untrusted';
  const signedOut = facts.auth === 'unauthenticated' || facts.auth === 'keyring';
  if (facts.installedVersion === null) {
    return signInOutranksUnreadVersion({ ...facts, signedOut }) ? 'unauthenticated' : 'unverified';
  }
  if (facts.compatibility === 'incompatible') return 'incompatible';
  if (facts.compatibility !== 'compatible') return 'unverified';
  if (signedOut) return 'unauthenticated';
  if (facts.auth !== 'authenticated' && facts.auth !== 'not-required') return 'unverified';
  return 'ready';
}
