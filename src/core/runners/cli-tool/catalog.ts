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
  CliToolDescriptor,
  CliToolId,
  RolePolicy,
  TypedOutputCapability,
} from './types.js';
import type { CliAuthChannel } from './auth-channels.js';
import { rolePolicy, cliToolTrust } from './builders.js';
import { ACTIVE_CLI_TOOL_DECLARATIONS } from './active.js';

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
    'claude-code': descriptor(trust['claude-code'], ACTIVE_CLI_TOOL_DECLARATIONS['claude-code']),
    codex: descriptor(trust.codex, ACTIVE_CLI_TOOL_DECLARATIONS.codex),
    opencode: descriptor(trust.opencode, ACTIVE_CLI_TOOL_DECLARATIONS.opencode),
    copilot: descriptor(trust.copilot, ACTIVE_CLI_TOOL_DECLARATIONS.copilot),
    'kilo-code': descriptor(trust['kilo-code'], ACTIVE_CLI_TOOL_DECLARATIONS['kilo-code']),
    cursor: descriptor(trust.cursor, ACTIVE_CLI_TOOL_DECLARATIONS.cursor),
    'command-code': descriptor(trust['command-code'], ACTIVE_CLI_TOOL_DECLARATIONS['command-code']),
    antigravity: descriptor(trust.antigravity, ACTIVE_CLI_TOOL_DECLARATIONS.antigravity),
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
