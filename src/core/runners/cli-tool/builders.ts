import type {
  CliAuthChannelId,
  CliAuthChannel,
  CliAuthPolicy,
  CliAuthChannels,
} from './auth-channels.js';
import type {
  CliAdmissionVerdict,
  CliPreflightFact,
  RolePolicy,
  RunnerRoleTrustMetadata,
  CliCompatibility,
  CliToolId,
  CliToolDeclarationBase,
  ActiveCliToolDeclaration,
} from './types.js';
import type { CliVersionScheme } from './version.js';

export const CURSOR_CLI_ADMISSION_VERDICT = 'PASS' satisfies CliAdmissionVerdict;

export const COMMAND_CODE_CLI_ADMISSION_VERDICT = 'PASS' satisfies CliAdmissionVerdict;

export const ANTIGRAVITY_CLI_ADMISSION_VERDICT = 'PASS' satisfies CliAdmissionVerdict;

export const ALL_ROLES = Object.freeze(['planner', 'implementer'] as const);
export const CLI_REQUIRED_PREFLIGHT_FACTS = Object.freeze([
  'executable',
  'trust',
  'version',
  'compatibility',
  'authentication',
  'model-catalog',
  'model-runnability',
] as const satisfies readonly CliPreflightFact[]);
const CLI_PLANNER_TRUST = Object.freeze({
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
  autoAllowFlags: Object.freeze([]),
});
const CLI_IMPLEMENTER_TRUST = Object.freeze({
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: true,
  autoAllowFlags: Object.freeze([]),
});

export function rolePolicy<T>(input: Readonly<{ planner: T; implementer: T }>): RolePolicy<T> {
  return Object.freeze({ planner: input.planner, implementer: input.implementer });
}

export function cliToolTrust(
  implementerAutoAllowFlags: readonly string[],
): RunnerRoleTrustMetadata {
  return Object.freeze({
    planner: CLI_PLANNER_TRUST,
    implementer: Object.freeze({
      ...CLI_IMPLEMENTER_TRUST,
      autoAllowFlags: Object.freeze([...implementerAutoAllowFlags]),
    }),
  });
}

export function authChannel(
  input: Readonly<{
    id: CliAuthChannelId;
    env: readonly string[];
    hostKeychainPlatforms?: readonly NodeJS.Platform[];
    supportedPlatforms?: readonly NodeJS.Platform[];
  }>,
): CliAuthChannel {
  return Object.freeze({
    id: input.id,
    env: Object.freeze([...input.env]),
    hostKeychainPlatforms: Object.freeze([...(input.hostKeychainPlatforms ?? [])]),
    ...(input.supportedPlatforms === undefined
      ? {}
      : { supportedPlatforms: Object.freeze([...input.supportedPlatforms]) }),
  });
}

export function authPolicy(kind: CliAuthPolicy['kind'], channels: CliAuthChannels): CliAuthPolicy {
  const env = [...new Set(channels.flatMap((channel) => channel.env))];
  return Object.freeze({
    kind,
    env: Object.freeze(env),
    channels: Object.freeze(channels),
  });
}

export function compatibility(
  input: Readonly<{
    installUrl: string;
    testedVersion: string;
    minimumAdmittedVersion: string;
    versionScheme: CliVersionScheme;
    asOf: string;
  }>,
): CliCompatibility {
  return Object.freeze({
    installUrl: input.installUrl,
    testedVersion: input.testedVersion,
    minimumAdmittedVersion: input.minimumAdmittedVersion,
    versionScheme: input.versionScheme,
    evidence: Object.freeze({ asOf: input.asOf }),
  });
}

export function activeCliToolDeclaration<Id extends CliToolId>(
  input: CliToolDeclarationBase<Id>,
): ActiveCliToolDeclaration<Id> {
  return Object.freeze({
    ...input,
    executableAliases: Object.freeze([...input.executableAliases]),
    roles: Object.freeze([...input.roles]),
    internalStatePaths: Object.freeze([...input.internalStatePaths]),
    mandatoryPreflightFacts: Object.freeze([...input.mandatoryPreflightFacts]),
    admission: Object.freeze({ state: 'active' }),
  });
}
