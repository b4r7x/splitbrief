import { z } from 'zod';
import {
  CliAuthStateSchema,
  CliCompatibilityStateSchema,
  CliExecutableIdentitySchema,
  CliProviderAuthSchema,
  type CliReadinessStateSchema,
  CliTrustStateSchema,
  NON_READY_CLI_READINESS_STATES,
} from '../discovery/detection.js';
import {
  CLI_AUTH_CHANNEL_IDS,
  CLI_TOOL_CATALOG,
  cliAuthChannelHostStateAccess,
  cliAuthChannelPlatformSupported,
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
 * The sign-in step every surface gives a signed-out tool; `names` is one tool or a list of them.
 * It ends on the command that names signed-out tools again from where the user is: `doctor`
 * checks a saved crew, and Setup (`init`) checks a project with or without one.
 */
export function cliSignInStep(names: string, recheck: 'doctor' | 'init'): string {
  return `Sign in to ${names}, then run \`splitbrief ${recheck}\` again.`;
}

export function cliAuthRemediation(
  runner: Readonly<{
    tool: CliReadinessFacts['tool'];
    authChannel?: CliReadinessFacts['authChannel'];
  }>,
): string {
  const channels = CLI_TOOL_CATALOG[runner.tool].auth.channels;
  const name = CLI_TOOL_CATALOG[runner.tool].displayName;
  const channel = channels.find((entry) => entry.id === runner.authChannel);
  if (channel === undefined) {
    return `Select an authentication channel for ${name}, then run \`splitbrief doctor\` again.`;
  }
  if (!cliAuthChannelPlatformSupported(channel)) {
    const supported = channel.supportedPlatforms?.map(platformName).join(', ');
    return `${name} ${channel.id} authentication is not supported on ${platformName(process.platform)}. Choose another tool in Settings > Crew, or use ${supported}.`;
  }
  const credentialEnv = channel.env[0];
  if (credentialEnv !== undefined) {
    return `Export ${credentialEnv} for ${name}, then run \`splitbrief doctor\` again.`;
  }
  const signIn = cliSignInStep(name, 'doctor');
  switch (cliAuthChannelHostStateAccess(channel)) {
    case 'host-account':
      return `SPLITBRIEF looks for the ${name} session in the ${platformName(process.platform)} keychain. ${signIn}`;
    case 'bridged-files':
      return `SPLITBRIEF looks for the ${name} session in its session files. ${signIn}`;
    case 'none':
      return signIn;
  }
}

export function cliExecutableTrustRemediation(name: string): string {
  return `Install ${name} outside the project. Put its absolute directory first on PATH, then run \`splitbrief doctor\` again.`;
}

export function cliReadinessRemediation(
  facts: Pick<
    CliReadinessFacts,
    'tool' | 'authChannel' | 'installedVersion' | 'testedVersion' | 'compatibility'
  >,
  status: Exclude<z.infer<typeof CliReadinessStateSchema>, 'ready'>,
): string {
  const name = CLI_TOOL_CATALOG[facts.tool].displayName;
  switch (status) {
    case 'disabled':
      return `Enable ${name} before selecting it as a runner.`;
    case 'unavailable':
      return `Install ${name}, then run \`splitbrief doctor\` again.`;
    case 'untrusted':
      return cliExecutableTrustRemediation(name);
    case 'incompatible':
      return `Install the tested ${name} version (${facts.testedVersion}), then run \`splitbrief doctor\` again.`;
    case 'unverified':
      if (facts.installedVersion === null || facts.compatibility !== 'compatible') {
        return `Verify ${name} against tested version ${facts.testedVersion}, then run \`splitbrief doctor\` again.`;
      }
      if (
        CLI_TOOL_CATALOG[facts.tool].auth.channels.some(
          (channel) =>
            channel.id === facts.authChannel && !cliAuthChannelPlatformSupported(channel),
        )
      )
        return cliAuthRemediation(facts);
      // Honest about the ceiling of a cheap check: stored credentials prove
      // presence, never a working session, and re-running readiness cannot
      // change that — only a real call can.
      return `${name} authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real ${name} call settles it; if that call fails to authenticate, sign in to ${name} again.`;
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
