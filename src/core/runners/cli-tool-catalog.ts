import { typedEntries } from '../../utils/type-guards.js';
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

export type CliAuthChannelId = 'api-key' | 'session' | 'provider-dependent';

export type CliAuthChannel = Readonly<{
  id: CliAuthChannelId;
  env: readonly string[];
  stateBridge: 'host-cli-state' | 'none';
  billing: RunnerBillingPosture;
}>;

export type CliAuthSelection = Readonly<{ channel: CliAuthChannelId }>;

export type CliAuthPolicy = Readonly<{
  kind: 'api-key-or-session' | 'session' | 'provider-dependent';
  env: readonly string[];
  stateBridge: 'host-cli-state' | 'none';
  channels: readonly CliAuthChannel[];
}>;

export type CliCompatibility = Readonly<{
  installUrl: string;
  testedVersion: string;
  evidence: Readonly<{ asOf: string }>;
}>;

type RolePolicy<T> = Readonly<Record<RunnerRole, T>>;
type CliSandboxPosture = 'none' | 'cli-managed' | 'mode-dependent';

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

export const CLI_TOOL_TRUST = Object.freeze({
  'claude-code': cliToolTrust(['--permission-mode acceptEdits']),
  codex: cliToolTrust(['--sandbox workspace-write']),
  opencode: cliToolTrust([]),
  aider: cliToolTrust(['--yes-always']),
  copilot: cliToolTrust(['--allow-all']),
  'kilo-code': cliToolTrust(['--auto']),
});

export type CliToolId = keyof typeof CLI_TOOL_TRUST;

export const CLI_TOOL_IDS = Object.freeze(typedEntries(CLI_TOOL_TRUST).map(([id]) => id));

function authChannel(
  id: CliAuthChannelId,
  env: readonly string[],
  stateBridge: CliAuthChannel['stateBridge'],
  billing: RunnerBillingPosture,
): CliAuthChannel {
  return Object.freeze({ id, env: Object.freeze([...env]), stateBridge, billing });
}

function authPolicy(
  kind: CliAuthPolicy['kind'],
  channels: readonly CliAuthChannel[],
): CliAuthPolicy {
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
    channels: Object.freeze([...channels]),
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
  const Id extends CliToolId,
  const Roles extends readonly RunnerRole[],
  const ModelPolicy extends RolePolicy<CliModelPolicy>,
>(input: {
  id: Id;
  displayName: string;
  command: string;
  roles: Roles;
  modelPolicy: ModelPolicy;
  auth: CliAuthPolicy;
  billing: RunnerBillingPosture;
  sandbox: RolePolicy<CliSandboxPosture>;
  compatibility: CliCompatibility;
}) {
  const trust = CLI_TOOL_TRUST[input.id];

  return Object.freeze({
    id: input.id,
    displayName: input.displayName,
    command: input.command,
    roles: input.roles,
    modelPolicy: input.modelPolicy,
    auth: input.auth,
    billing: input.billing,
    directWrite: trustPolicy(trust, 'mayWriteFilesDirectly'),
    network: trustPolicy(trust, 'mayUseNetwork'),
    shell: trustPolicy(trust, 'executesLocalCommand'),
    automaticApproval: rolePolicy(
      trust.planner.autoAllowFlags.length > 0,
      trust.implementer.autoAllowFlags.length > 0,
    ),
    sandbox: input.sandbox,
    compatibility: input.compatibility,
  });
}

export const CLI_TOOL_CATALOG = Object.freeze({
  'claude-code': descriptor({
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
  codex: descriptor({
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
  opencode: descriptor({
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
  aider: descriptor({
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
  copilot: descriptor({
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
  'kilo-code': descriptor({
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
} satisfies Readonly<Record<CliToolId, CliToolDescriptor>>);

export function cliModelPolicyViolations(
  policy: CliModelPolicy,
  selection: CliModelSelection,
): readonly CliModelPolicyViolation[] {
  const violations: CliModelPolicyViolation[] = [];
  const model = selection.model;

  if (model?.trim().toLowerCase() === 'auto') {
    violations.push({
      field: 'model',
      message: 'model "auto" is not a model ID; omit model to use automatic selection',
    });
  } else if (policy === 'required' && model === undefined) {
    violations.push({ field: 'model', message: 'model is required by this CLI model policy' });
  } else if ((policy === 'backend-default' || policy === 'auto-only') && model !== undefined) {
    violations.push({
      field: 'model',
      message: `model must be omitted for the "${policy}" CLI model policy`,
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

function cliToolIdsForRole(role: RunnerRole): readonly CliToolId[] {
  return Object.freeze(CLI_TOOL_IDS.filter((id) => cliToolSupportsRole(id, role)));
}

export const PLANNER_CLI_TOOL_IDS = cliToolIdsForRole('planner');
export const IMPLEMENTER_CLI_TOOL_IDS = cliToolIdsForRole('implementer');
