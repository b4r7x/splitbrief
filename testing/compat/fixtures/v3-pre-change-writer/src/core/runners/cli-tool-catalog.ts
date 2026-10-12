import { typedEntries } from '../../utils/type-guards.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../providers/automatic-model.js';
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
}>;

export type CliAuthSelection = Readonly<{ channel: CliAuthChannelId }>;

export type CliAuthChannels = readonly [CliAuthChannel, ...CliAuthChannel[]];

export type CliAuthPolicy = Readonly<{
  kind: 'api-key-or-session' | 'session' | 'provider-dependent';
  env: readonly string[];
  stateBridge: 'host-cli-state' | 'none';
  channels: CliAuthChannels;
}>;

export type CliCompatibility = Readonly<{
  installUrl: string;
  testedVersion: string;
  evidence: Readonly<{ asOf: string }>;
}>;

type RolePolicy<T> = Readonly<Record<RunnerRole, T>>;
type CliSandboxPosture = 'none' | 'cli-managed' | 'mode-dependent';

export type CliAdmissionVerdict = 'PASS' | 'OMIT';

export type CursorCliAdmissionVerdict = typeof CURSOR_CLI_ADMISSION_VERDICT;
export const CURSOR_CLI_ADMISSION_VERDICT = 'OMIT' satisfies CliAdmissionVerdict;

export type AntigravityCliAdmissionVerdict = typeof ANTIGRAVITY_CLI_ADMISSION_VERDICT;
export const ANTIGRAVITY_CLI_ADMISSION_VERDICT = 'OMIT' satisfies CliAdmissionVerdict;

export const EXCLUDED_CLI_TOOL_IDS = Object.freeze([
  'kiro',
  'gemini',
  'auggie',
  'junie',
  'cline',
  'qwen',
] as const);

export const CURSOR_CLI_CANDIDATE_PATHS = Object.freeze([
  'src/engine/runners/cli-tools/cursor-parser.ts',
  'src/engine/runners/cli-tools/cursor.ts',
  'src/engine/runners/cli-tools/cursor.test.ts',
] as const);

export const ANTIGRAVITY_CLI_CANDIDATE_PATHS = Object.freeze([
  'src/engine/runners/cli-tools/antigravity.ts',
  'src/engine/runners/cli-tools/antigravity.test.ts',
] as const);

type ExistingCliToolId = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'copilot' | 'kilo-code';

type CursorCliToolId = CursorCliAdmissionVerdict extends 'PASS' ? 'cursor' : never;
type AntigravityCliToolId = AntigravityCliAdmissionVerdict extends 'PASS' ? 'antigravity' : never;

export type CliToolId = ExistingCliToolId | CursorCliToolId | AntigravityCliToolId;

export type CliToolDescriptor = Readonly<{
  id: CliToolId;
  displayName: string;
  command: string;
  roles: readonly RunnerRole[];
  modelPolicy: RolePolicy<CliModelPolicy>;
  auth: CliAuthPolicy;
  billing: RunnerBillingPosture;
  directWrite: RolePolicy<boolean>;
  network: RolePolicy<boolean>;
  shell: RolePolicy<boolean>;
  automaticApproval: RolePolicy<boolean>;
  sandbox: RolePolicy<CliSandboxPosture>;
  compatibility: CliCompatibility;
}>;

const ALL_ROLES = Object.freeze(['planner', 'implementer'] as const);
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

function cliToolTrust(implementerAutoAllowFlags: readonly string[]): RunnerRoleTrustMetadata {
  return Object.freeze({
    planner: CLI_PLANNER_TRUST,
    implementer: Object.freeze({
      ...CLI_IMPLEMENTER_TRUST,
      autoAllowFlags: Object.freeze([...implementerAutoAllowFlags]),
    }),
  });
}

const BASE_CLI_TOOL_TRUST = Object.freeze({
  'claude-code': cliToolTrust(['--permission-mode acceptEdits']),
  codex: cliToolTrust(['--sandbox workspace-write']),
  opencode: cliToolTrust([]),
  aider: cliToolTrust(['--yes-always']),
  copilot: cliToolTrust(['--allow-all']),
  'kilo-code': cliToolTrust(['--auto']),
});

function authChannel(
  id: CliAuthChannelId,
  env: readonly string[],
  stateBridge: CliAuthChannel['stateBridge'],
  billing: RunnerBillingPosture,
): CliAuthChannel {
  return Object.freeze({ id, env: Object.freeze([...env]), stateBridge, billing });
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

function compatibility(installUrl: string, testedVersion: string, asOf: string): CliCompatibility {
  return Object.freeze({
    installUrl,
    testedVersion,
    evidence: Object.freeze({ asOf }),
  });
}

function trustPolicy(
  trust: Readonly<Record<RunnerRole, RunnerTrustMetadata>>,
  field: 'mayWriteFilesDirectly' | 'mayUseNetwork' | 'executesLocalCommand',
): RolePolicy<boolean> {
  return rolePolicy(trust.planner[field], trust.implementer[field]);
}

function descriptor<
  const Id extends string,
  const Roles extends readonly RunnerRole[],
  const ModelPolicy extends RolePolicy<CliModelPolicy>,
>(
  trust: Readonly<Record<Id, RunnerRoleTrustMetadata>>,
  input: {
    id: Id;
    displayName: string;
    command: string;
    roles: Roles;
    modelPolicy: ModelPolicy;
    auth: CliAuthPolicy;
    billing: RunnerBillingPosture;
    sandbox: RolePolicy<CliSandboxPosture>;
    compatibility: CliCompatibility;
  },
) {
  const toolTrust = trust[input.id];

  return Object.freeze({
    id: input.id,
    displayName: input.displayName,
    command: input.command,
    roles: input.roles,
    modelPolicy: input.modelPolicy,
    auth: input.auth,
    billing: input.billing,
    directWrite: trustPolicy(toolTrust, 'mayWriteFilesDirectly'),
    network: trustPolicy(toolTrust, 'mayUseNetwork'),
    shell: trustPolicy(toolTrust, 'executesLocalCommand'),
    automaticApproval: rolePolicy(
      toolTrust.planner.autoAllowFlags.length > 0,
      toolTrust.implementer.autoAllowFlags.length > 0,
    ),
    sandbox: input.sandbox,
    compatibility: input.compatibility,
  });
}

function buildBaseCatalog(trust: Readonly<Record<CliToolId, RunnerRoleTrustMetadata>>) {
  return {
    'claude-code': descriptor(trust, {
      id: 'claude-code',
      displayName: 'Claude Code CLI',
      command: 'claude',
      roles: ALL_ROLES,
      modelPolicy: rolePolicy('optional', 'optional'),
      auth: authPolicy('api-key-or-session', [
        authChannel('session', [], 'host-cli-state', 'subscription-included'),
        authChannel('api-key', ['ANTHROPIC_API_KEY'], 'none', 'api-metered'),
      ]),
      billing: 'subscription-included',
      sandbox: rolePolicy('none', 'none'),
      compatibility: compatibility('https://claude.ai/code', '2.0.0', '2026-07-31'),
    }),
    codex: descriptor(trust, {
      id: 'codex',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      roles: ALL_ROLES,
      modelPolicy: rolePolicy('optional', 'optional'),
      auth: authPolicy('api-key-or-session', [
        authChannel('session', [], 'host-cli-state', 'subscription-included'),
        authChannel('api-key', ['OPENAI_API_KEY'], 'none', 'api-metered'),
      ]),
      billing: 'subscription-included',
      sandbox: rolePolicy('mode-dependent', 'cli-managed'),
      compatibility: compatibility('https://github.com/openai/codex', '0.40.0', '2026-07-31'),
    }),
    opencode: descriptor(trust, {
      id: 'opencode',
      displayName: 'OpenCode CLI',
      command: 'opencode',
      roles: ALL_ROLES,
      modelPolicy: rolePolicy('optional', 'optional'),
      auth: authPolicy('provider-dependent', [
        authChannel('provider-dependent', [], 'host-cli-state', 'provider-dependent'),
      ]),
      billing: 'provider-dependent',
      sandbox: rolePolicy('none', 'none'),
      compatibility: compatibility('https://opencode.ai', '0.5.0', '2026-07-31'),
    }),
    aider: descriptor(trust, {
      id: 'aider',
      displayName: 'Aider CLI',
      command: 'aider',
      roles: ALL_ROLES,
      modelPolicy: rolePolicy('optional', 'optional'),
      auth: authPolicy('provider-dependent', [
        authChannel('provider-dependent', [], 'none', 'provider-dependent'),
      ]),
      billing: 'provider-dependent',
      sandbox: rolePolicy('none', 'none'),
      compatibility: compatibility('https://aider.chat', '0.86.0', '2026-07-31'),
    }),
    copilot: descriptor(trust, {
      id: 'copilot',
      displayName: 'GitHub Copilot CLI',
      command: 'copilot',
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
      sandbox: rolePolicy('none', 'none'),
      compatibility: compatibility('https://github.com/github/copilot-cli', '0.3.0', '2026-07-31'),
    }),
    'kilo-code': descriptor(trust, {
      id: 'kilo-code',
      displayName: 'Kilo Code CLI',
      command: 'kilo',
      roles: ALL_ROLES,
      modelPolicy: rolePolicy('optional', 'optional'),
      auth: authPolicy('provider-dependent', [
        authChannel('provider-dependent', [], 'host-cli-state', 'provider-dependent'),
      ]),
      billing: 'provider-dependent',
      sandbox: rolePolicy('none', 'none'),
      compatibility: compatibility('https://kilo.ai', '0.1.0', '2026-07-31'),
    }),
  };
}

function assertOmittedCandidatesAbsent(): void {
  assertCandidateFilesAbsent(
    [...CURSOR_CLI_CANDIDATE_PATHS, ...ANTIGRAVITY_CLI_CANDIDATE_PATHS],
    cliAdmissionError.omitRequiresAbsentSource,
  );
}

function assembleCliToolTrust(): Readonly<Record<CliToolId, RunnerRoleTrustMetadata>> {
  assertOmittedCandidatesAbsent();
  const trust: Record<ExistingCliToolId, RunnerRoleTrustMetadata> = { ...BASE_CLI_TOOL_TRUST };
  return Object.freeze(trust);
}

function assembleCliToolCatalog(
  trust: Readonly<Record<CliToolId, RunnerRoleTrustMetadata>>,
): Readonly<Record<CliToolId, CliToolDescriptor>> {
  const catalog: Record<ExistingCliToolId, CliToolDescriptor> = {
    ...buildBaseCatalog(trust),
  };
  return Object.freeze(catalog);
}

export const CLI_TOOL_TRUST = assembleCliToolTrust();
export const CLI_TOOL_CATALOG = assembleCliToolCatalog(CLI_TOOL_TRUST);
export const CLI_TOOL_IDS = Object.freeze(typedEntries(CLI_TOOL_CATALOG).map(([id]) => id));

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
 * The channel a runner takes when its configuration names none: the declared
 * channel that needs no host state bridge, so an unset selection never copies
 * host credential files into the staged sandbox on its own.
 */
export function defaultCliAuthChannel(id: CliToolId): CliAuthChannel {
  const { channels } = CLI_TOOL_CATALOG[id].auth;
  return channels.find((channel) => channel.stateBridge === 'none') ?? channels[0];
}

function cliToolIdsForRole(role: RunnerRole): readonly CliToolId[] {
  return Object.freeze(CLI_TOOL_IDS.filter((id) => cliToolSupportsRole(id, role)));
}

export const PLANNER_CLI_TOOL_IDS = cliToolIdsForRole('planner');
export const IMPLEMENTER_CLI_TOOL_IDS = cliToolIdsForRole('implementer');
