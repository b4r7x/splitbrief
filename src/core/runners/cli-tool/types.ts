import type { CliEffortChannel } from '../effort-channel.js';
import type { RunnerBillingPosture } from '../runner-billing.js';
import type { RunnerRole } from '../seat-roles.js';
import type { CliAuthPolicy } from './auth-channels.js';
import type { CliVersionScheme } from './version.js';

export type RunnerTrustMetadata = Readonly<{
  executesLocalCommand: boolean;
  mayUseNetwork: boolean;
  mayWriteFilesDirectly: boolean;
  autoAllowFlags: readonly string[];
}>;

export type RunnerRoleTrustMetadata = Readonly<Record<RunnerRole, RunnerTrustMetadata>>;

export type CliModelPolicy = 'required' | 'optional' | 'backend-default' | 'auto-only';

export type CliModelSelection = Readonly<{
  model?: string | undefined;
  customModels?: readonly string[] | undefined;
}>;

export type CliModelPolicyViolation = Readonly<{
  field: 'model' | 'customModels';
  message: string;
}>;

export type CliCompatibility = Readonly<{
  installUrl: string;
  testedVersion: string;
  minimumAdmittedVersion: string;
  versionScheme: CliVersionScheme;
  evidence: Readonly<{ asOf: string }>;
}>;

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

export type RolePolicy<T> = Readonly<Record<RunnerRole, T>>;
type CliSandboxPosture = 'none' | 'cli-managed' | 'mode-dependent';
type ExistingCliToolId =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'copilot'
  | 'kilo-code'
  | 'cursor'
  | 'command-code'
  | 'antigravity';

export type CliToolId = ExistingCliToolId;

/** How one call asks for a typed answer: the tool's own JSON Schema channel, or the prompt. */
export type TypedOutputTransport = 'native' | 'fallback';

/**
 * How a seat can take a typed answer. `strict-native` is a native channel that takes only a
 * schema OpenAI strict mode accepts; every other schema goes through the prompt.
 */
export type TypedOutputCapability = TypedOutputTransport | 'strict-native';

/**
 * Whether the tool takes a JSON Schema for its final answer on its own command line. `since` is
 * the release whose `--help` and live probe recorded the flag; no older release is proven.
 */
export type TypedOutputSupport =
  | Readonly<{ kind: 'native' | 'strict-native'; since: string }>
  | Readonly<{ kind: 'fallback' }>;

/** How a seat receives an image: a path-taking flag, stdin content blocks, or not at all. */
export type ImageInputSupport = 'flag' | 'stdin' | 'none';

export type CliToolDeclarationBase<Id extends string = string> = Readonly<{
  id: Id;
  displayName: string;
  command: string;
  executableAliases: readonly string[];
  category: 'cli';
  roles: readonly RunnerRole[];
  modelPolicy: RolePolicy<CliModelPolicy>;
  /** Whether SPLITBRIEF sends a per-call effort flag. */
  supportsEffort: boolean;
  /** How the tool's effort intent reaches it, when it has a channel at all. */
  effortChannel: CliEffortChannel;
  typedOutput: TypedOutputSupport;
  imageInput: ImageInputSupport;
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

export type CliToolDescriptor<Id extends string = CliToolId> = Readonly<
  ActiveCliToolDeclaration<Id> & {
    directWrite: RolePolicy<boolean>;
    network: RolePolicy<boolean>;
    shell: RolePolicy<boolean>;
    automaticApproval: RolePolicy<boolean>;
  }
>;

export type CliAdmissionVerdict = 'PASS' | 'OMIT';
