import { z } from 'zod';
import {
  CliAuthStateSchema,
  CliCompatibilityStateSchema,
  CliExecutableIdentitySchema,
  CliProviderAuthFactSchema,
  type CliReadinessStateSchema,
  CliTrustStateSchema,
  NON_READY_CLI_READINESS_STATES,
} from '../discovery/detection.js';
import {
  CLI_AUTH_CHANNEL_IDS,
  CLI_TOOL_CATALOG,
  cliAuthChannelHostStateAccess,
} from '../runners/cli-tool-catalog.js';
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
  'set-budget',
  'exit',
] as const;
export const ReadinessNextActionKindSchema = z.enum(READINESS_NEXT_ACTION_KINDS);
export type ReadinessNextActionKind = z.infer<typeof ReadinessNextActionKindSchema>;

export const READINESS_DIAGNOSTIC_STATE_IDS = [
  'missing-binary',
  'untrusted-path',
  'incompatible-version',
  'unauthenticated',
  'auth-unknown',
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
});

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
    /**
     * The channel `auth` is a fact about. Absent when no channel was selected,
     * which is also the only case where the remedy cannot name the credential
     * the runner needs.
     */
    authChannel: z.enum(CLI_AUTH_CHANNEL_IDS).optional(),
    /** Per-provider oracle facts; present only when a credential oracle ran cleanly. */
    providerAuth: z.array(CliProviderAuthFactSchema).max(64).readonly().optional(),
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
  if (facts.installedVersion === null) return 'unverified';
  if (facts.compatibility === 'incompatible') return 'incompatible';
  if (facts.compatibility !== 'compatible') return 'unverified';
  if (facts.auth === 'unauthenticated') return 'unauthenticated';
  if (facts.auth !== 'authenticated' && facts.auth !== 'not-required') return 'unverified';
  return 'ready';
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

function platformName(platform: NodeJS.Platform): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * Names the credential the staged runner is actually missing and the command
 * that supplies it. A generic "authenticate this tool" is worse than useless
 * here: the reader needs to know which store the staged environment looked in,
 * because that is what decides whether signing in again will change anything.
 */
export function cliAuthRemediation(
  runner: Readonly<{
    tool: CliReadinessFacts['tool'];
    authChannel?: CliReadinessFacts['authChannel'];
  }>,
): string {
  const channels = CLI_TOOL_CATALOG[runner.tool].auth.channels;
  const channel = channels.find((entry) => entry.id === runner.authChannel);
  if (channel === undefined) {
    return `Select an authentication channel for ${runner.tool}, then run \`splitbrief doctor\` again.`;
  }
  const credentialEnv = channel.env[0];
  if (credentialEnv !== undefined) {
    return `Export ${credentialEnv} for the ${runner.tool} ${channel.id} channel, then run \`splitbrief doctor\` again.`;
  }
  const cause =
    cliAuthChannelHostStateAccess(channel) === 'host-account'
      ? `On ${platformName(process.platform)} the ${runner.tool} ${channel.id} credential lives in the OS keychain, which the isolated runner environment reads with the host account, and ${runner.tool} reported no session there.`
      : `No ${runner.tool} ${channel.id} credential reached the isolated runner environment, which bridges session state only as files.`;
  return `${cause} Sign in to ${runner.tool} on this host, then run \`splitbrief doctor\` again.`;
}

function cliReadinessRemediation(
  facts: CliReadinessFacts,
  status: Exclude<z.infer<typeof CliReadinessStateSchema>, 'ready'>,
): string {
  switch (status) {
    case 'disabled':
      return `Enable ${facts.tool} before selecting it as a runner.`;
    case 'unavailable':
      return `Install ${facts.tool}, then run runner readiness again.`;
    case 'untrusted':
      return `Trust the exact ${facts.tool} executable identity, then run runner readiness again.`;
    case 'incompatible':
      return `Install the tested ${facts.tool} version (${facts.testedVersion}), then run runner readiness again.`;
    case 'unverified':
      if (facts.installedVersion === null || facts.compatibility !== 'compatible') {
        return `Verify ${facts.tool} against tested version ${facts.testedVersion}, then run runner readiness again.`;
      }
      // Honest about the ceiling of a cheap check: stored credentials prove
      // presence, never a working session, and re-running readiness cannot
      // change that — only a real call can.
      return `${facts.tool} authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real ${facts.tool} call settles it; if that call fails to authenticate, sign in to ${facts.tool} again.`;
    case 'unauthenticated':
      return cliAuthRemediation(facts);
  }
}

export function deriveCliReadiness(input: CliReadinessFacts): CliReadinessResult {
  const facts = CliReadinessFactsSchema.parse(input);
  const status = deriveCliReadinessStatus(facts);
  const checkId = cliReadinessCheckId(facts.tool);
  if (status === 'ready') return { ...facts, checkId, status, remediation: null };
  return { ...facts, checkId, status, remediation: cliReadinessRemediation(facts, status) };
}
