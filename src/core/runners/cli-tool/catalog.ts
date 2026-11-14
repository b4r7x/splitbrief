import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../../providers/automatic-model.js';
import { includes, typedEntries } from '../../../utils/type-guards.js';
import { classifyCliAdmittedVersion } from './version.js';
import type { RunnerRole } from '../seat-roles.js';
import type {
  CliModelPolicy,
  RunnerRoleTrustMetadata,
  CliModelSelection,
  CliModelPolicyViolation,
  ActiveCliToolDeclaration,
  CliToolAdmissionDeclaration,
  CliToolDescriptor,
  CliToolId,
  CustomOnlyCliToolExclusion,
  RolePolicy,
  TypedOutputCapability,
} from './types.js';
import type { CliAuthChannel } from './auth-channels.js';
import {
  activeCliToolDeclaration,
  ALL_ROLES,
  rolePolicy,
  authPolicy,
  authChannel,
  compatibility,
  CLI_REQUIRED_PREFLIGHT_FACTS,
  cliToolTrust,
} from './builders.js';

export const CLI_TOOL_DECLARATIONS = Object.freeze({
  'claude-code': activeCliToolDeclaration({
    id: 'claude-code',
    displayName: 'Claude Code CLI',
    command: 'claude',
    executableAliases: ['claude'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: true,
    effortChannel: 'effort-flag',
    typedOutput: { kind: 'native', since: '2.1.287' },
    imageInput: 'stdin',
    auth: authPolicy('session', [
      authChannel({
        id: 'session',
        env: [],
        billing: 'subscription-included',
        hostKeychainPlatforms: ['darwin'],
      }),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy({ planner: 'none', implementer: 'cli-managed' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://claude.ai/code',
      testedVersion: '2.0.0',
      minimumAdmittedVersion: '2.0.0',
      versionScheme: 'semver',
      asOf: '2026-07-31',
    }),
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
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: true,
    effortChannel: 'effort-flag',
    typedOutput: { kind: 'strict-native', since: '0.157.1' },
    imageInput: 'flag',
    auth: authPolicy('session', [
      authChannel({
        id: 'session',
        env: [],
        billing: 'subscription-included',
      }),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy({ planner: 'mode-dependent', implementer: 'cli-managed' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://github.com/openai/codex',
      testedVersion: '0.40.0',
      minimumAdmittedVersion: '0.40.0',
      versionScheme: 'semver',
      asOf: '2026-07-31',
    }),
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
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: false,
    effortChannel: 'variant',
    typedOutput: { kind: 'fallback' },
    imageInput: 'flag',
    auth: authPolicy('provider-dependent', [
      authChannel({
        id: 'provider-dependent',
        env: [],
        billing: 'provider-dependent',
      }),
    ]),
    billing: 'provider-dependent',
    isSubscription: false,
    sandbox: rolePolicy({ planner: 'none', implementer: 'none' }),
    internalStatePaths: [
      '.opencode/package-lock.json',
      '.opencode/package.json',
      '.opencode/node_modules/',
    ],
    compatibility: compatibility({
      installUrl: 'https://opencode.ai',
      testedVersion: '2.0.14',
      minimumAdmittedVersion: '0.5.0',
      versionScheme: 'semver',
      asOf: '2026-09-22',
    }),
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  copilot: activeCliToolDeclaration({
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    command: 'copilot',
    executableAliases: ['copilot'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: true,
    effortChannel: 'effort-flag',
    typedOutput: { kind: 'fallback' },
    imageInput: 'flag',
    auth: authPolicy('session', [
      authChannel({
        id: 'session',
        env: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
        billing: 'subscription-included',
        hostKeychainPlatforms: ['darwin'],
      }),
    ]),
    billing: 'subscription-included',
    isSubscription: true,
    sandbox: rolePolicy({ planner: 'none', implementer: 'none' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://github.com/github/copilot-cli',
      testedVersion: '1.0.77',
      minimumAdmittedVersion: '0.3.0',
      versionScheme: 'semver',
      asOf: '2026-09-02',
    }),
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  'kilo-code': activeCliToolDeclaration({
    id: 'kilo-code',
    displayName: 'Kilo Code CLI',
    command: 'kilo',
    executableAliases: ['kilo'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: false,
    effortChannel: 'variant',
    typedOutput: { kind: 'fallback' },
    imageInput: 'flag',
    auth: authPolicy('provider-dependent', [
      authChannel({
        id: 'provider-dependent',
        env: [],
        billing: 'provider-dependent',
      }),
    ]),
    billing: 'provider-dependent',
    isSubscription: true,
    sandbox: rolePolicy({ planner: 'none', implementer: 'none' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://kilo.ai',
      testedVersion: '0.1.0',
      minimumAdmittedVersion: '0.1.0',
      versionScheme: 'semver',
      asOf: '2026-07-31',
    }),
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  cursor: activeCliToolDeclaration({
    id: 'cursor',
    displayName: 'Cursor Agent CLI',
    command: 'cursor-agent',
    executableAliases: ['cursor-agent', 'agent'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: false,
    effortChannel: 'model-id',
    typedOutput: { kind: 'fallback' },
    imageInput: 'none',
    auth: authPolicy('session', [
      authChannel({
        id: 'session',
        env: [],
        billing: 'subscription-included',
        hostKeychainPlatforms: ['darwin'],
      }),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy({ planner: 'none', implementer: 'none' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://cursor.com/cli',
      testedVersion: '2026.08.25-3e8eec8',
      minimumAdmittedVersion: '2026.08.25-3e8eec8',
      versionScheme: 'calver',
      asOf: '2026-08-27',
    }),
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  'command-code': activeCliToolDeclaration({
    id: 'command-code',
    displayName: 'Command Code CLI',
    command: 'cmd',
    executableAliases: ['cmd'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: true,
    effortChannel: 'effort-flag',
    typedOutput: { kind: 'fallback' },
    imageInput: 'none',
    auth: authPolicy('session', [
      authChannel({
        id: 'session',
        env: [],
        billing: 'subscription-included',
      }),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy({ planner: 'none', implementer: 'none' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://commandcode.ai/',
      testedVersion: '1.39.2',
      minimumAdmittedVersion: '1.39.2',
      versionScheme: 'semver',
      asOf: '2026-09-01',
    }),
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
  kiro: Object.freeze({
    id: 'kiro',
    displayName: 'Amazon Kiro CLI',
    category: 'cli',
    admission: Object.freeze({
      state: 'custom-only',
      reason: 'SPLITBRIEF has no structured session-scoped model and output adapter for it.',
    }),
  } satisfies CustomOnlyCliToolExclusion),
  antigravity: activeCliToolDeclaration({
    id: 'antigravity',
    displayName: 'Google Antigravity CLI',
    command: 'agy',
    executableAliases: ['agy'],
    category: 'cli',
    roles: ALL_ROLES,
    modelPolicy: rolePolicy({ planner: 'optional', implementer: 'optional' }),
    supportsEffort: false,
    effortChannel: 'model-id',
    typedOutput: { kind: 'native', since: '1.2.14' },
    imageInput: 'none',
    auth: authPolicy('session', [
      authChannel({
        id: 'session',
        env: [],
        billing: 'subscription-included',
        hostKeychainPlatforms: ['darwin'],
        supportedPlatforms: ['darwin'],
      }),
    ]),
    billing: 'subscription-included',
    isSubscription: false,
    sandbox: rolePolicy({ planner: 'none', implementer: 'none' }),
    internalStatePaths: [],
    compatibility: compatibility({
      installUrl: 'https://antigravity.google/docs/cli',
      testedVersion: '1.4.7',
      // Before 1.3.2, `--dangerously-skip-permissions` also approved a plan-mode plan, and the
      // planner seat passes that flag.
      minimumAdmittedVersion: '1.3.2',
      versionScheme: 'semver',
      asOf: '2026-10-24',
    }),
    modelDiscoveryMode: 'native-cli',
    mandatoryPreflightFacts: CLI_REQUIRED_PREFLIGHT_FACTS,
  }),
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

const BASE_CLI_TOOL_TRUST = Object.freeze({
  'claude-code': cliToolTrust(['--permission-mode acceptEdits']),
  codex: cliToolTrust(['--sandbox workspace-write']),
  opencode: cliToolTrust([]),
  copilot: cliToolTrust(['--allow-all']),
  'kilo-code': cliToolTrust(['--auto']),
  cursor: cliToolTrust(['--force']),
  'command-code': cliToolTrust(['--yolo']),
  antigravity: cliToolTrust(['--dangerously-skip-permissions']),
} satisfies Record<CliToolId, RunnerRoleTrustMetadata>);

function trustPolicy(
  trust: RunnerRoleTrustMetadata,
  field: 'mayWriteFilesDirectly' | 'mayUseNetwork' | 'executesLocalCommand',
): RolePolicy<boolean> {
  return rolePolicy({ planner: trust.planner[field], implementer: trust.implementer[field] });
}

function descriptor<Id extends CliToolId>(
  trust: RunnerRoleTrustMetadata,
  input: ActiveCliToolDeclaration<Id>,
): CliToolDescriptor<Id> {
  return Object.freeze({
    ...input,
    directWrite: trustPolicy(trust, 'mayWriteFilesDirectly'),
    network: trustPolicy(trust, 'mayUseNetwork'),
    shell: trustPolicy(trust, 'executesLocalCommand'),
    automaticApproval: rolePolicy({
      planner: trust.planner.autoAllowFlags.length > 0,
      implementer: trust.implementer.autoAllowFlags.length > 0,
    }),
  });
}

function assembleCliToolTrust(): Readonly<Record<CliToolId, RunnerRoleTrustMetadata>> {
  return Object.freeze({ ...BASE_CLI_TOOL_TRUST });
}

function assembleCliToolCatalog(
  trust: Readonly<Record<CliToolId, RunnerRoleTrustMetadata>>,
): Readonly<Record<CliToolId, CliToolDescriptor>> {
  const catalog = {
    'claude-code': descriptor(trust['claude-code'], CLI_TOOL_DECLARATIONS['claude-code']),
    codex: descriptor(trust.codex, CLI_TOOL_DECLARATIONS.codex),
    opencode: descriptor(trust.opencode, CLI_TOOL_DECLARATIONS.opencode),
    copilot: descriptor(trust.copilot, CLI_TOOL_DECLARATIONS.copilot),
    'kilo-code': descriptor(trust['kilo-code'], CLI_TOOL_DECLARATIONS['kilo-code']),
    cursor: descriptor(trust.cursor, CLI_TOOL_DECLARATIONS.cursor),
    'command-code': descriptor(trust['command-code'], CLI_TOOL_DECLARATIONS['command-code']),
    antigravity: descriptor(trust.antigravity, CLI_TOOL_DECLARATIONS.antigravity),
  } satisfies Record<CliToolId, CliToolDescriptor>;
  return Object.freeze(catalog);
}

export const CLI_TOOL_TRUST = assembleCliToolTrust();
export const CLI_TOOL_CATALOG = assembleCliToolCatalog(CLI_TOOL_TRUST);
export const CLI_TOOL_IDS = Object.freeze(typedEntries(CLI_TOOL_CATALOG).map(([id]) => id));

// Runs when a config names it; no surface offers it.
const UNLISTED_CLI_TOOL_IDS: readonly CliToolId[] = ['copilot'];

export function isListedCliTool(id: string): boolean {
  return !includes(UNLISTED_CLI_TOOL_IDS, id);
}

export const LISTED_CLI_TOOL_IDS = Object.freeze(CLI_TOOL_IDS.filter(isListedCliTool));

/**
 * The only admitted CLIs with a structural, non-interactive native model
 * catalog contract. This is intentionally narrower than `modelDiscoveryMode`:
 * a display policy is not permission to execute a catalog subprocess.
 */
export const NATIVE_CLI_CATALOG_TOOL_IDS = Object.freeze([
  'codex',
  'opencode',
  'copilot',
  'kilo-code',
  'cursor',
  'command-code',
  'antigravity',
] as const satisfies readonly CliToolId[]);

export function hasNativeCliCatalog(tool: string): boolean {
  return NATIVE_CLI_CATALOG_TOOL_IDS.some((id) => id === tool);
}

export function isCliToolId(tool: string): tool is CliToolId {
  return Object.hasOwn(CLI_TOOL_CATALOG, tool);
}

/** The tool whose own command a runner call is named after: the Claude runner names its calls `claude`. */
export function cliToolIdForCommand(command: string): CliToolId | undefined {
  return CLI_TOOL_IDS.find((id) => CLI_TOOL_CATALOG[id].command === command);
}

/** The tool an executable name starts, by any of its executable aliases (Cursor also installs `agent`). */
export function cliToolIdForExecutable(name: string): CliToolId | undefined {
  return CLI_TOOL_IDS.find((id) => CLI_TOOL_CATALOG[id].executableAliases.includes(name));
}

/**
 * The admitted CLIs that ship a read-only per-provider credential listing.
 * Both the probe commands and the detection normalizer derive from this set,
 * so a new oracle tool cannot be recognised on only one side.
 */
export const PROVIDER_ORACLE_TOOL_IDS = Object.freeze([
  'opencode',
  'kilo-code',
] as const satisfies readonly CliToolId[]);

/**
 * A version the probe could not read says nothing about the tool, so it does not outrank a sign-in
 * found absent. A provider-listing tool still calls a provider with no stored credential, so for
 * that tool an absent sign-in decides nothing here.
 */
export function signInOutranksUnreadVersion(
  input: Readonly<{ tool: string; installedVersion: string | null; signedOut: boolean }>,
): boolean {
  return (
    input.installedVersion === null &&
    input.signedOut &&
    !PROVIDER_ORACLE_TOOL_IDS.some((id) => id === input.tool)
  );
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

// A release older than the proven one gets the prompt fallback; an unknown release keeps the
// native flag, as every other release-gated flag of an adapter does.
export function typedOutputCapability(
  id: CliToolId,
  installedVersion: string | undefined,
): TypedOutputCapability {
  const { typedOutput, compatibility } = CLI_TOOL_CATALOG[id];
  if (typedOutput.kind === 'fallback') return 'fallback';
  if (installedVersion === undefined) return typedOutput.kind;
  const proven = classifyCliAdmittedVersion({
    installedVersion,
    minimumAdmittedVersion: typedOutput.since,
    versionScheme: compatibility.versionScheme,
  });
  return proven === 'incompatible' ? 'fallback' : typedOutput.kind;
}

export function cliToolSupportsRole(id: CliToolId, role: RunnerRole): boolean {
  return CLI_TOOL_CATALOG[id].roles.includes(role);
}

export function getCliModelPolicy(id: CliToolId, role: RunnerRole): CliModelPolicy {
  return CLI_TOOL_CATALOG[id].modelPolicy[role];
}

/**
 * The channel every CLI runner of the tool runs on: the one channel the tool declares, the
 * sign-in the tool already has. It is platform-independent — every declared channel reaches a
 * staged child on every platform SPLITBRIEF runs on, as files or as the host account, so a
 * config keeps its meaning wherever it is opened.
 */
export function defaultCliAuthChannel(id: CliToolId): CliAuthChannel {
  return CLI_TOOL_CATALOG[id].auth.channels[0];
}

function cliToolIdsForRole(role: RunnerRole): readonly CliToolId[] {
  return Object.freeze(CLI_TOOL_IDS.filter((id) => cliToolSupportsRole(id, role)));
}

export const PLANNER_CLI_TOOL_IDS = cliToolIdsForRole('planner');
export const IMPLEMENTER_CLI_TOOL_IDS = cliToolIdsForRole('implementer');
