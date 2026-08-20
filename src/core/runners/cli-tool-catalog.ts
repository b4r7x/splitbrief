import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../providers/automatic-model.js';
import type { PlannerArtifactTransport } from '../schemas/task-compilation.js';
import { typedEntries } from '../../utils/type-guards.js';
import { assertCandidateFilesAbsent } from './candidate-admission.js';
import { cliAdmissionError } from './cli-admission-error.js';
import type { RunnerBillingPosture } from './runner-billing.js';

export type RunnerRole = 'planner' | 'implementer';

export type RunnerTrustMetadata = Readonly<{
  executesLocalCommand: boolean;
  mayUseNetwork: boolean;
  mayWriteFilesDirectly: boolean;
  autoAllowFlags: readonly string[];
}>;

export type RunnerRoleTrustMetadata = Readonly<Record<RunnerRole, RunnerTrustMetadata>>;

export type CliPlannerTier2FullEscalationTrust = Readonly<{
  mayWriteFilesDirectly: true;
  autoAllowFlags: readonly string[];
}>;

export type CliToolTrustMetadata = RunnerRoleTrustMetadata &
  Readonly<{
    plannerTier2FullEscalation: CliPlannerTier2FullEscalationTrust;
  }>;

export type CliModelPolicy = 'required' | 'optional' | 'backend-default' | 'auto-only';

export type CliModelSelection = Readonly<{
  model?: string | undefined;
  customModels?: readonly string[] | undefined;
}>;

export type CliModelPolicyViolation = Readonly<{
  field: 'model' | 'customModels';
  message: string;
}>;

export const CLI_AUTH_CHANNEL_IDS = Object.freeze([
  'api-key',
  'session',
  'provider-dependent',
] as const);

export type CliAuthChannelId = (typeof CLI_AUTH_CHANNEL_IDS)[number];

export type CliAuthChannel = Readonly<{
  id: CliAuthChannelId;
  env: readonly string[];
  stateBridge: 'host-cli-state' | 'none';
  billing: RunnerBillingPosture;
  /**
   * Platforms where this channel's credential is an OS keychain item rather
   * than a file, so the file-copying state bridge has nothing to carry. macOS
   * keeps the Claude Code session in the login keychain, whose default search
   * list resolves through `HOME` and whose item is keyed on the account name in
   * `USER`; a staged child reaches it only when both keep their host values.
   */
  hostKeychainPlatforms: readonly NodeJS.Platform[];
}>;

/**
 * How a channel's host credential reaches a staged child.
 *
 * - `none` — the channel carries no host state; an API-key channel passes an
 *   environment variable instead.
 * - `bridged-files` — a read-only snapshot of this tool's own credential files
 *   is copied into the sandbox, whose `HOME` the child keeps.
 * - `host-account` — the credential is an OS keychain item, so nothing is
 *   copied and the child keeps the host `HOME` and `USER` instead.
 */
export type CliHostStateAccess = 'none' | 'bridged-files' | 'host-account';

export function cliAuthChannelHostStateAccess(
  channel: CliAuthChannel,
  platform: NodeJS.Platform = process.platform,
): CliHostStateAccess {
  if (channel.stateBridge !== 'host-cli-state') return 'none';
  return channel.hostKeychainPlatforms.includes(platform) ? 'host-account' : 'bridged-files';
}

export type CliAuthSelection = Readonly<{ channel: CliAuthChannelId }>;

export type CliAuthChannels = readonly [CliAuthChannel, ...CliAuthChannel[]];

export type CliAuthPolicy = Readonly<{
  kind: 'api-key' | 'api-key-or-session' | 'session' | 'provider-dependent';
  env: readonly string[];
  stateBridge: 'host-cli-state' | 'none';
  channels: CliAuthChannels;
}>;

export type CliVersionCompatibility = 'compatible' | 'incompatible' | 'unverified';

type CanonicalSemver = Readonly<{
  major: number;
  minor: number;
  patch: number;
}>;

const CANONICAL_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseCanonicalSemver(version: string): CanonicalSemver | null {
  const match = CANONICAL_SEMVER.exec(version);
  if (match === null) return null;

  const [majorPart, minorPart, patchPart] = match.slice(1);
  if (majorPart === undefined || minorPart === undefined || patchPart === undefined) return null;

  const parsed = {
    major: Number(majorPart),
    minor: Number(minorPart),
    patch: Number(patchPart),
  };
  return Number.isSafeInteger(parsed.major) &&
    Number.isSafeInteger(parsed.minor) &&
    Number.isSafeInteger(parsed.patch)
    ? parsed
    : null;
}

function compareCanonicalSemver(
  input: Readonly<{ left: CanonicalSemver; right: CanonicalSemver }>,
): number {
  if (input.left.major !== input.right.major) {
    return input.left.major < input.right.major ? -1 : 1;
  }
  if (input.left.minor !== input.right.minor) {
    return input.left.minor < input.right.minor ? -1 : 1;
  }
  if (input.left.patch !== input.right.patch) {
    return input.left.patch < input.right.patch ? -1 : 1;
  }
  return 0;
}

/**
 * The sole descriptor-owned semantic-version compatibility decision.
 * Forward-compatible: releases at or above the minimum admitted version are
 * compatible; only older releases fail closed as incompatible. An unparseable
 * version stays unverified.
 */
export function classifyCliAdmittedVersion(
  input: Readonly<{
    installedVersion: string;
    minimumAdmittedVersion: string;
  }>,
): CliVersionCompatibility {
  const installed = parseCanonicalSemver(input.installedVersion);
  const minimum = parseCanonicalSemver(input.minimumAdmittedVersion);
  if (installed === null || minimum === null) return 'unverified';
  return compareCanonicalSemver({ left: installed, right: minimum }) < 0
    ? 'incompatible'
    : 'compatible';
}

export type CliCompilerVersionClassification = 'exact' | 'older' | 'newer' | 'mismatch';

/**
 * The compiler path admits exactly the tested runtime version (REQ-049).
 * Older releases, newer releases, and unparseable claims are never ready —
 * unlike the forward-compatible `classifyCliAdmittedVersion` used by the
 * implementer path, this classifier has no compatibility arm to borrow.
 */
export function classifyCliCompilerVersion(
  input: Readonly<{
    installedVersion: string;
    exactAdmittedVersion: string;
  }>,
): CliCompilerVersionClassification {
  const installed = parseCanonicalSemver(input.installedVersion);
  const exact = parseCanonicalSemver(input.exactAdmittedVersion);
  if (installed === null || exact === null) return 'mismatch';
  const order = compareCanonicalSemver({ left: installed, right: exact });
  if (order === 0) return 'exact';
  return order < 0 ? 'older' : 'newer';
}

export type CliCompatibility = Readonly<{
  installUrl: string;
  testedVersion: string;
  minimumAdmittedVersion: string;
  evidence: Readonly<{ asOf: string }>;
}>;

export const CLI_AUTH_DISCOVERY_MODES = Object.freeze([
  'selected-channel',
  'provider-dependent-unverified',
  'static-unverified',
  'status-unverified',
] as const);

export type CliAuthDiscoveryMode = (typeof CLI_AUTH_DISCOVERY_MODES)[number];

export const CLI_MODEL_DISCOVERY_MODES = Object.freeze([
  'native-aliases-and-custom',
  'capability-gated-native',
  'native-cli',
  'static-catalog-unverified',
  'account-visible-model-list',
] as const);

export type CliModelDiscoveryMode = (typeof CLI_MODEL_DISCOVERY_MODES)[number];

export const CLI_PREFLIGHT_FACTS = Object.freeze([
  'executable',
  'trust',
  'version',
  'compatibility',
  'authentication',
  'model-catalog',
  'model-runnability',
] as const);

export type CliPreflightFact = (typeof CLI_PREFLIGHT_FACTS)[number];

type RolePolicy<T> = Readonly<Record<RunnerRole, T>>;
type CliSandboxPosture = 'none' | 'cli-managed' | 'mode-dependent';
type ExistingCliToolId = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'copilot' | 'kilo-code';

export type CliToolId = ExistingCliToolId;

export type CliToolDeclarationBase<Id extends string = string> = Readonly<{
  id: Id;
  displayName: string;
  command: string;
  executableAliases: readonly string[];
  category: 'cli';
  roles: readonly RunnerRole[];
  modelPolicy: RolePolicy<CliModelPolicy>;
  auth: CliAuthPolicy;
  billing: RunnerBillingPosture;
  isSubscription: boolean;
  sandbox: RolePolicy<CliSandboxPosture>;
  /**
   * Project-relative path prefixes — exact files, or directories with a
   * trailing `/` — the tool rewrites as its own per-project state on startup,
   * e.g. OpenCode regenerates its `.opencode/` plugin lockfile on every
   * launch. Mutation guards treat churn under these prefixes as tool-internal
   * housekeeping, never runner-authored output. Declare only the regenerated
   * state itself: user-authored config under the same dot-directory (e.g.
   * `.opencode/plugin/`) must stay guarded.
   */
  internalStatePaths: readonly string[];
  compatibility: CliCompatibility;
  authDiscoveryMode: CliAuthDiscoveryMode;
  modelDiscoveryMode: CliModelDiscoveryMode;
  mandatoryPreflightFacts: readonly CliPreflightFact[];
}>;

export type ActiveCliToolDeclaration<Id extends string = string> = CliToolDeclarationBase<Id> &
  Readonly<{ admission: Readonly<{ state: 'active' }> }>;

export type CustomOnlyCliToolExclusion = Readonly<{
  id: string;
  displayName: string;
  category: 'cli';
  admission: Readonly<{
    state: 'custom-only';
    reason: string;
  }>;
}>;

export type CliToolAdmissionDeclaration = ActiveCliToolDeclaration | CustomOnlyCliToolExclusion;

export type CliToolDescriptor<Id extends string = CliToolId> = Readonly<
  ActiveCliToolDeclaration<Id> & {
    directWrite: RolePolicy<boolean>;
    network: RolePolicy<boolean>;
    shell: RolePolicy<boolean>;
    automaticApproval: RolePolicy<boolean>;
    plannerTier2FullEscalation: CliPlannerTier2FullEscalationTrust;
  }
>;

export type CliAdmissionVerdict = 'PASS' | 'OMIT';

export const CURSOR_CLI_ADMISSION_VERDICT = 'OMIT' satisfies CliAdmissionVerdict;

export const ANTIGRAVITY_CLI_ADMISSION_VERDICT = 'OMIT' satisfies CliAdmissionVerdict;

export type CursorCliCandidate = Readonly<{
  id: 'cursor';
  displayName: 'Cursor Agent CLI';
  command: 'agent';
  executableAliases: readonly ['agent', 'cursor-agent'];
  category: 'cli';
  admission: Readonly<{
    state: 'not-admitted';
    prerequisite: 'R7-008';
    remediation: string;
  }>;
}>;

export const CURSOR_CLI_CANDIDATE: CursorCliCandidate = Object.freeze({
  id: 'cursor',
  displayName: 'Cursor Agent CLI',
  command: 'agent',
  executableAliases: Object.freeze(['agent', 'cursor-agent'] as const),
  category: 'cli',
  admission: Object.freeze({
    state: 'not-admitted',
    prerequisite: 'R7-008',
    remediation:
      'Cursor Agent CLI is unavailable until R7-008 verifies an exact build-pinned protocol and a fresh filtered workspace.',
  }),
});

const ALL_ROLES = Object.freeze(['planner', 'implementer'] as const);
const CLI_REQUIRED_PREFLIGHT_FACTS = Object.freeze([
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

function rolePolicy<T>(planner: T, implementer: T): RolePolicy<T> {
  return Object.freeze({ planner, implementer });
}

function cliToolTrust(
  input: Readonly<{
    implementerAutoAllowFlags: readonly string[];
    tier2AutoAllowFlags: readonly string[];
  }>,
): CliToolTrustMetadata {
  return Object.freeze({
    planner: CLI_PLANNER_TRUST,
    implementer: Object.freeze({
      ...CLI_IMPLEMENTER_TRUST,
      autoAllowFlags: Object.freeze([...input.implementerAutoAllowFlags]),
    }),
    plannerTier2FullEscalation: Object.freeze({
      mayWriteFilesDirectly: true,
      autoAllowFlags: Object.freeze([...input.tier2AutoAllowFlags]),
    }),
  });
}

function authChannel(
  id: CliAuthChannelId,
  env: readonly string[],
  stateBridge: CliAuthChannel['stateBridge'],
  billing: RunnerBillingPosture,
  hostKeychainPlatforms: readonly NodeJS.Platform[] = [],
): CliAuthChannel {
  return Object.freeze({
    id,
    env: Object.freeze([...env]),
    stateBridge,
    billing,
    hostKeychainPlatforms: Object.freeze([...hostKeychainPlatforms]),
  });
}

function authPolicy(kind: CliAuthPolicy['kind'], channels: CliAuthChannels): CliAuthPolicy {
  const env = [
    ...new Set(
      channels
        .filter((channel) => channel.billing !== 'api-metered')
        .flatMap((channel) => channel.env),
    ),
  ];
  const stateBridge = channels.some((channel) => channel.stateBridge === 'host-cli-state')
    ? 'host-cli-state'
    : 'none';
  return Object.freeze({
    kind,
    env: Object.freeze(env),
    stateBridge,
    channels: Object.freeze(channels),
  });
}

function compatibility(
  input: Readonly<{
    installUrl: string;
    testedVersion: string;
    minimumAdmittedVersion: string;
    asOf: string;
  }>,
): CliCompatibility {
  return Object.freeze({
    installUrl: input.installUrl,
    testedVersion: input.testedVersion,
    minimumAdmittedVersion: input.minimumAdmittedVersion,
    evidence: Object.freeze({ asOf: input.asOf }),
  });
}

function activeCliToolDeclaration<Id extends CliToolId>(
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

export const CLI_TOOL_DECLARATIONS = Object.freeze({
  'claude-code': activeCliToolDeclaration({
    id: 'claude-code',
    displayName: 'Claude Code CLI',
    command: 'claude',
    executableAliases: ['claude'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy('optional', 'optional'),
    auth: authPolicy('api-key-or-session', [
      authChannel('session', [], 'host-cli-state', 'subscription-included', ['darwin']),
      authChannel('api-key', ['ANTHROPIC_API_KEY'], 'none', 'api-metered'),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy('none', 'none'),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://claude.ai/code',
      testedVersion: '2.0.0',
      minimumAdmittedVersion: '2.0.0',
      asOf: '2026-07-31',
    }),
    authDiscoveryMode: 'selected-channel',
    modelDiscoveryMode: 'native-aliases-and-custom',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  codex: activeCliToolDeclaration({
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    command: 'codex',
    executableAliases: ['codex'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy('optional', 'optional'),
    auth: authPolicy('api-key-or-session', [
      authChannel('session', [], 'host-cli-state', 'subscription-included'),
      authChannel('api-key', ['OPENAI_API_KEY'], 'none', 'api-metered'),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy('mode-dependent', 'cli-managed'),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://github.com/openai/codex',
      testedVersion: '0.40.0',
      minimumAdmittedVersion: '0.40.0',
      asOf: '2026-07-31',
    }),
    authDiscoveryMode: 'selected-channel',
    modelDiscoveryMode: 'capability-gated-native',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  opencode: activeCliToolDeclaration({
    id: 'opencode',
    displayName: 'OpenCode CLI',
    command: 'opencode',
    executableAliases: ['opencode'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy('optional', 'optional'),
    auth: authPolicy('provider-dependent', [
      authChannel('provider-dependent', [], 'host-cli-state', 'provider-dependent'),
    ]),
    billing: 'provider-dependent',
    isSubscription: false,
    sandbox: rolePolicy('none', 'none'),
    internalStatePaths: [
      '.opencode/package-lock.json',
      '.opencode/package.json',
      '.opencode/node_modules/',
    ],
    compatibility: compatibility({
      installUrl: 'https://opencode.ai',
      testedVersion: '0.5.0',
      minimumAdmittedVersion: '0.5.0',
      asOf: '2026-07-31',
    }),
    authDiscoveryMode: 'provider-dependent-unverified',
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  aider: activeCliToolDeclaration({
    id: 'aider',
    displayName: 'Aider CLI',
    command: 'aider',
    executableAliases: ['aider'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy('optional', 'optional'),
    auth: authPolicy('provider-dependent', [
      authChannel('provider-dependent', [], 'none', 'provider-dependent'),
    ]),
    billing: 'provider-dependent',
    isSubscription: false,
    sandbox: rolePolicy('none', 'none'),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://aider.chat',
      testedVersion: '0.86.0',
      minimumAdmittedVersion: '0.86.0',
      asOf: '2026-07-31',
    }),
    authDiscoveryMode: 'static-unverified',
    modelDiscoveryMode: 'static-catalog-unverified',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  copilot: activeCliToolDeclaration({
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    command: 'copilot',
    executableAliases: ['copilot'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy('optional', 'optional'),
    auth: authPolicy('session', [
      authChannel(
        'session',
        ['GH_TOKEN', 'GITHUB_TOKEN'],
        'host-cli-state',
        'subscription-included',
      ),
    ]),
    billing: 'subscription-included',
    isSubscription: true,
    sandbox: rolePolicy('none', 'none'),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://github.com/github/copilot-cli',
      testedVersion: '0.3.0',
      minimumAdmittedVersion: '0.3.0',
      asOf: '2026-07-31',
    }),
    authDiscoveryMode: 'static-unverified',
    modelDiscoveryMode: 'static-catalog-unverified',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  'kilo-code': activeCliToolDeclaration({
    id: 'kilo-code',
    displayName: 'Kilo Code CLI',
    command: 'kilo',
    executableAliases: ['kilo'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy('optional', 'optional'),
    auth: authPolicy('provider-dependent', [
      authChannel('provider-dependent', [], 'host-cli-state', 'provider-dependent'),
    ]),
    billing: 'provider-dependent',
    isSubscription: true,
    sandbox: rolePolicy('none', 'none'),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://kilo.ai',
      testedVersion: '0.1.0',
      minimumAdmittedVersion: '0.1.0',
      asOf: '2026-07-31',
    }),
    authDiscoveryMode: 'provider-dependent-unverified',
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  kiro: Object.freeze({
    id: 'kiro',
    displayName: 'Amazon Kiro CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason: 'A structured session-scoped model and output adapter is not yet proven.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  antigravity: Object.freeze({
    id: 'antigravity',
    displayName: 'Google Antigravity CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Structured output, noninteractive authentication, and a safe auth probe are not proven.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  gemini: Object.freeze({
    id: 'gemini',
    displayName: 'Gemini CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Its auth, discovery, and permission contracts do not meet first-class-admission requirements.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  cline: Object.freeze({
    id: 'cline',
    displayName: 'Cline CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Its auth, discovery, and permission contracts do not meet first-class-admission requirements.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  qwen: Object.freeze({
    id: 'qwen',
    displayName: 'Qwen Code',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason:
        'Its auth, discovery, and permission contracts do not meet first-class-admission requirements.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
} satisfies Record<string, CliToolAdmissionDeclaration>);

export const CUSTOM_ONLY_CLI_TOOL_DEFINITIONS = Object.freeze([
  CLI_TOOL_DECLARATIONS.kiro,
  CLI_TOOL_DECLARATIONS.antigravity,
  CLI_TOOL_DECLARATIONS.gemini,
  CLI_TOOL_DECLARATIONS.cline,
  CLI_TOOL_DECLARATIONS.qwen,
]);

export const CUSTOM_ONLY_CLI_TOOL_IDS = Object.freeze(
  CUSTOM_ONLY_CLI_TOOL_DEFINITIONS.map((tool) => tool.id),
);

export const EXCLUDED_CLI_TOOL_IDS = Object.freeze([
  ...CUSTOM_ONLY_CLI_TOOL_IDS,
  'auggie',
  'junie',
]);

export const ANTIGRAVITY_CLI_CANDIDATE_PATHS = Object.freeze([
  'src/engine/runners/cli-tools/antigravity.ts',
  'src/engine/runners/cli-tools/antigravity.test.ts',
] as const);

export const CURSOR_CLI_RUNTIME_ADAPTER_PATHS = Object.freeze([
  'src/engine/runners/cli-tools/cursor.ts',
] as const);

const BASE_CLI_TOOL_TRUST = Object.freeze({
  'claude-code': cliToolTrust({
    implementerAutoAllowFlags: ['--permission-mode acceptEdits'],
    tier2AutoAllowFlags: [],
  }),
  codex: cliToolTrust({
    implementerAutoAllowFlags: ['--sandbox workspace-write'],
    tier2AutoAllowFlags: ['--sandbox workspace-write'],
  }),
  opencode: cliToolTrust({ implementerAutoAllowFlags: [], tier2AutoAllowFlags: [] }),
  aider: cliToolTrust({
    implementerAutoAllowFlags: ['--yes-always'],
    tier2AutoAllowFlags: ['--yes-always'],
  }),
  copilot: cliToolTrust({
    implementerAutoAllowFlags: ['--allow-all'],
    tier2AutoAllowFlags: ['--allow-all', '--no-ask-user'],
  }),
  'kilo-code': cliToolTrust({
    implementerAutoAllowFlags: ['--auto'],
    tier2AutoAllowFlags: ['--auto'],
  }),
} satisfies Record<CliToolId, CliToolTrustMetadata>);

function trustPolicy(
  trust: RunnerRoleTrustMetadata,
  field: 'mayWriteFilesDirectly' | 'mayUseNetwork' | 'executesLocalCommand',
): RolePolicy<boolean> {
  return rolePolicy(trust.planner[field], trust.implementer[field]);
}

function descriptor<Id extends CliToolId>(
  trust: CliToolTrustMetadata,
  input: ActiveCliToolDeclaration<Id>,
): CliToolDescriptor<Id> {
  return Object.freeze({
    ...input,
    directWrite: trustPolicy(trust, 'mayWriteFilesDirectly'),
    network: trustPolicy(trust, 'mayUseNetwork'),
    shell: trustPolicy(trust, 'executesLocalCommand'),
    automaticApproval: rolePolicy(
      trust.planner.autoAllowFlags.length > 0,
      trust.implementer.autoAllowFlags.length > 0,
    ),
    plannerTier2FullEscalation: trust.plannerTier2FullEscalation,
  });
}

function assertOmittedCandidatesAbsent(): void {
  assertCandidateFilesAbsent(
    [...CURSOR_CLI_RUNTIME_ADAPTER_PATHS, ...ANTIGRAVITY_CLI_CANDIDATE_PATHS],
    cliAdmissionError.omitRequiresAbsentSource,
  );
}

function assembleCliToolTrust(): Readonly<Record<CliToolId, CliToolTrustMetadata>> {
  assertOmittedCandidatesAbsent();
  return Object.freeze({ ...BASE_CLI_TOOL_TRUST });
}

function assembleCliToolCatalog(
  trust: Readonly<Record<CliToolId, CliToolTrustMetadata>>,
): Readonly<Record<CliToolId, CliToolDescriptor>> {
  const catalog = {
    'claude-code': descriptor(trust['claude-code'], CLI_TOOL_DECLARATIONS['claude-code']),
    codex: descriptor(trust.codex, CLI_TOOL_DECLARATIONS.codex),
    opencode: descriptor(trust.opencode, CLI_TOOL_DECLARATIONS.opencode),
    aider: descriptor(trust.aider, CLI_TOOL_DECLARATIONS.aider),
    copilot: descriptor(trust.copilot, CLI_TOOL_DECLARATIONS.copilot),
    'kilo-code': descriptor(trust['kilo-code'], CLI_TOOL_DECLARATIONS['kilo-code']),
  } satisfies Record<CliToolId, CliToolDescriptor>;
  return Object.freeze(catalog);
}

export const CLI_TOOL_TRUST = assembleCliToolTrust();
export const CLI_TOOL_CATALOG = assembleCliToolCatalog(CLI_TOOL_TRUST);
export const CLI_TOOL_IDS = Object.freeze(typedEntries(CLI_TOOL_CATALOG).map(([id]) => id));

export type CliCompilerSupportState = 'required-baseline' | 'conformance-gated' | 'unsupported';

export type CliCompilerEvidence = Readonly<{
  state: CliCompilerSupportState;
  /** The exact admitted runtime version; always empty for an unsupported tool. */
  version: string;
  transports: readonly PlannerArtifactTransport['kind'][];
  terminalContract: string;
  fixtureDate: string;
  unsupportedReason?: string;
}>;

function compilerEvidence(evidence: CliCompilerEvidence): CliCompilerEvidence {
  return Object.freeze({
    ...evidence,
    transports: Object.freeze([...evidence.transports]),
  });
}

/**
 * The single owner of the CLI rows of the compiler support table: the engine
 * table (`src/engine/runners/compiler-capability.ts`) builds its six CLI rows
 * from this record and adds only the capability-only fields, so the identity
 * evidence cannot diverge. The compiler path admits only the exact tested
 * runtime (REQ-019, REQ-049), so this evidence never carries a minimum, a
 * range, or a secret value.
 */
export const CLI_COMPILER_EVIDENCE: Readonly<Record<CliToolId, CliCompilerEvidence>> =
  Object.freeze({
    'claude-code': compilerEvidence({
      state: 'conformance-gated',
      version: '2.1.232',
      transports: Object.freeze(['stdout-final']),
      terminalContract: 'claude-terminal-result-v1',
      fixtureDate: '2026-08-15',
    }),
    codex: compilerEvidence({
      state: 'conformance-gated',
      version: '0.147.0',
      transports: Object.freeze(['declared-file']),
      terminalContract: 'codex-output-last-message-v1',
      fixtureDate: '2026-08-15',
    }),
    opencode: compilerEvidence({
      state: 'required-baseline',
      version: '1.18.15',
      transports: Object.freeze(['stdout-final']),
      terminalContract: 'opencode-final-message-v1',
      fixtureDate: '2026-08-15',
    }),
    aider: compilerEvidence({
      state: 'unsupported',
      version: '',
      transports: Object.freeze([]),
      terminalContract: 'unsupported',
      fixtureDate: '2026-08-15',
      unsupportedReason: 'no proven read-only planner contract in V1',
    }),
    copilot: compilerEvidence({
      state: 'unsupported',
      version: '',
      transports: Object.freeze([]),
      terminalContract: 'unsupported',
      fixtureDate: '2026-08-15',
      unsupportedReason: 'no proven non-writing programmatic planner posture in V1',
    }),
    'kilo-code': compilerEvidence({
      state: 'conformance-gated',
      version: '7.0.49',
      transports: Object.freeze(['stdout-final']),
      terminalContract: 'kilo-final-message-v1',
      fixtureDate: '2026-08-15',
    }),
  });

/**
 * The only admitted CLIs with a structural, non-interactive native model
 * catalog contract. This is intentionally narrower than `modelDiscoveryMode`:
 * a display policy is not permission to execute a catalog subprocess.
 */
export const NATIVE_CLI_CATALOG_TOOL_IDS = Object.freeze([
  'codex',
  'opencode',
  'aider',
  'kilo-code',
] as const satisfies readonly CliToolId[]);

export function hasNativeCliCatalog(tool: string): boolean {
  return NATIVE_CLI_CATALOG_TOOL_IDS.some((id) => id === tool);
}

export function cliModelPolicyViolations(
  policy: CliModelPolicy,
  selection: CliModelSelection,
): readonly CliModelPolicyViolation[] {
  const violations: CliModelPolicyViolation[] = [];
  const model = normalizeConfiguredModel(selection.model);
  const automatic = model === undefined || model === AUTOMATIC_MODEL;

  if (policy === 'required' && automatic) {
    violations.push({
      field: 'model',
      message:
        model === undefined
          ? 'model is required by this CLI model policy'
          : 'model "auto" delegates to the tool default, but this CLI model policy requires an explicit model ID',
    });
  } else if ((policy === 'backend-default' || policy === 'auto-only') && !automatic) {
    violations.push({
      field: 'model',
      message: `model must be omitted or "auto" for the "${policy}" CLI model policy`,
    });
  }

  if (
    (policy === 'backend-default' || policy === 'auto-only') &&
    selection.customModels !== undefined
  ) {
    violations.push({
      field: 'customModels',
      message: `custom models are not supported by the "${policy}" CLI model policy`,
    });
  }

  return violations;
}

export function cliToolSupportsRole(id: CliToolId, role: RunnerRole): boolean {
  return CLI_TOOL_CATALOG[id].roles.includes(role);
}

export function getCliModelPolicy(id: CliToolId, role: RunnerRole): CliModelPolicy {
  return CLI_TOOL_CATALOG[id].modelPolicy[role];
}

export function selectCliAuthChannel(
  id: CliToolId,
  selection: CliAuthSelection | undefined,
): CliAuthChannel | undefined {
  if (selection === undefined) return undefined;
  return CLI_TOOL_CATALOG[id].auth.channels.find((channel) => channel.id === selection.channel);
}

/**
 * The channel a runner takes when its configuration names none, and the one a
 * freshly written config declares: the tool's declared session channel when it
 * has one (a host login is the tool's primary auth), otherwise its first
 * bridge-free channel, otherwise its first declared channel. It is
 * platform-independent — every declared session channel reaches a staged child
 * on every platform SPLITBRIEF runs on, as files or as the host account, so a
 * config keeps its meaning wherever it is opened. An explicit `authChannel`
 * always overrides it.
 */
export function defaultCliAuthChannel(id: CliToolId): CliAuthChannel {
  const channels = CLI_TOOL_CATALOG[id].auth.channels;
  return (
    channels.find((channel) => channel.id === 'session') ??
    channels.find((channel) => channel.stateBridge === 'none') ??
    channels[0]
  );
}

function cliToolIdsForRole(role: RunnerRole): readonly CliToolId[] {
  return Object.freeze(CLI_TOOL_IDS.filter((id) => cliToolSupportsRole(id, role)));
}

export const PLANNER_CLI_TOOL_IDS = cliToolIdsForRole('planner');
export const IMPLEMENTER_CLI_TOOL_IDS = cliToolIdsForRole('implementer');
