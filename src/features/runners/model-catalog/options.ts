import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { CliProviderAuthFact } from '../../../core/discovery/detection.js';
import {
  API_PROVIDER_CATALOG,
  KNOWN_API_PROVIDER_IDS,
  type ApiProviderDescriptor,
  type DataUsePosture,
} from '../../../core/providers/api-provider-catalog.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { hasAutomaticModelDefault } from '../../../core/providers/model-selection.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type CliToolDescriptor,
  type RunnerRole,
} from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerBillingPosture } from '../../../core/runners/runner-billing.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import type { ImplementerConfig } from '../../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import {
  cliPermissions,
  deriveModelCatalogCapability,
  metaBilling,
  metaModelPolicy,
  trustPermissions,
  type ModelCatalogCapability,
  type PickerModelPolicy,
  type RunnerPermissionPosture,
} from './posture.js';
import {
  deriveApiStatus,
  deriveCliStatus,
  deriveMetaStatus,
  isSelectable,
  resolveCliVersion,
  type PickerDetectionSnapshot,
  type PickerOptionStatus,
} from './status.js';

export type RunnerPickerDescriptor =
  | Readonly<{ kind: 'cli'; descriptor: CliToolDescriptor }>
  | Readonly<{ kind: 'api'; descriptor: ApiProviderDescriptor }>
  | Readonly<{ kind: 'custom-command' | 'agent-sdk' }>;

interface PickerOptionBase {
  id: string;
  displayName: string;
  roles: readonly RunnerRole[];
  modelPolicy: PickerModelPolicy;
  modelCapability: ModelCatalogCapability;
  billing: RunnerBillingPosture;
  dataUse?: DataUsePosture;
  permissions: RunnerPermissionPosture;
  status: PickerOptionStatus;
  available: boolean;
  version?: string | undefined;
  isCurrent?: boolean;
  /**
   * The tool routes calls through per-provider accounts that its own
   * credential oracle can enumerate; only these options grow the provider
   * axis (row tags, auth glyphs, sticky token) in the model column.
   */
  providerDependent?: boolean;
}

export interface RunnerPickerOption extends PickerOptionBase {
  kind: RunnerKind;
}

/** The single "+ Add custom command…" launcher; the contract (shell vs agent) is chosen after selection. */
export interface CustomCommandLauncherOption extends PickerOptionBase {
  kind: 'custom-command';
}

export type PickerOption = RunnerPickerOption | CustomCommandLauncherOption;

/**
 * The active runner identity needed to derive availability. This intentionally
 * excludes the runner config so picker status never receives credentials.
 */
export interface PickerStatusLens {
  readonly activeRunnerId: string | undefined;
}

function pickerDescriptorId(entry: RunnerPickerDescriptor): string {
  if (entry.kind === 'cli') return entry.descriptor.id;
  if (entry.kind === 'api') return entry.descriptor.id;
  return entry.kind;
}

function descriptorRoles(entry: RunnerPickerDescriptor): readonly RunnerRole[] {
  if (entry.kind === 'cli') return entry.descriptor.roles;
  if (entry.kind === 'api') return entry.descriptor.roles;
  return ['planner', 'implementer'];
}

function descriptorSupportsRole(entry: RunnerPickerDescriptor, role: RunnerRole): boolean {
  return descriptorRoles(entry).includes(role);
}

function projectCliOption(
  descriptor: CliToolDescriptor,
  role: RunnerRole,
  detections: PickerDetectionSnapshot,
  isCurrent: boolean,
): PickerOption {
  const status = deriveCliStatus(descriptor, detections);
  const version = resolveCliVersion(descriptor.id, detections);
  // Provider-dependent auth plus a native model listing is exactly the pair
  // the credential oracle serves; a static catalog stays a single-axis list.
  const providerDependent =
    descriptor.auth.kind === 'provider-dependent' && descriptor.modelDiscoveryMode === 'native-cli';

  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    kind: 'cli',
    roles: descriptor.roles,
    modelPolicy: descriptor.modelPolicy[role],
    modelCapability: deriveModelCatalogCapability(descriptor.modelPolicy[role], true),
    billing: descriptor.billing,
    permissions: cliPermissions(descriptor, role),
    status,
    available: isSelectable(status, 'cli'),
    ...(version ? { version } : {}),
    ...(isCurrent ? { isCurrent: true } : {}),
    ...(providerDependent ? { providerDependent: true } : {}),
  };
}

function projectApiOption(
  descriptor: ApiProviderDescriptor,
  role: RunnerRole,
  detections: PickerDetectionSnapshot,
  isCurrent: boolean,
): PickerOption {
  const status = deriveApiStatus(descriptor, detections, role);

  return {
    id: descriptor.id,
    displayName: getProviderDisplayName(descriptor.id),
    kind: 'api',
    roles: descriptor.roles,
    modelPolicy: 'per-call',
    modelCapability: deriveModelCatalogCapability(
      'per-call',
      hasAutomaticModelDefault(descriptor.id),
    ),
    billing: descriptor.billing,
    dataUse: descriptor.dataUse,
    permissions: trustPermissions('api', role),
    status,
    available: isSelectable(status, 'api'),
    ...(isCurrent ? { isCurrent: true } : {}),
  };
}

function projectMetaOption(
  kind: 'custom-command' | 'agent-sdk',
  role: RunnerRole,
  detections: PickerDetectionSnapshot,
  isCurrent: boolean,
  useConfiguredProviderOutcome: boolean,
): PickerOption {
  const status = deriveMetaStatus(kind, detections, role, useConfiguredProviderOutcome);

  const common = {
    id: kind,
    displayName: kind === 'custom-command' ? 'Custom command' : getProviderDisplayName(kind),
    roles: ['planner', 'implementer'] satisfies readonly RunnerRole[],
    modelPolicy: metaModelPolicy(kind),
    modelCapability: deriveModelCatalogCapability(metaModelPolicy(kind), kind === 'agent-sdk'),
    billing: metaBilling(kind),
    permissions: trustPermissions(kind === 'custom-command' ? 'shell' : kind, role),
    status,
    available: isSelectable(status, kind),
    ...(isCurrent ? { isCurrent: true } : {}),
  };
  return kind === 'custom-command' ? { ...common, kind } : { ...common, kind };
}

function sortPickerOptions(a: PickerOption, b: PickerOption): number {
  // The launcher stays last so a typed filter always puts real matches under
  // the cursor; it is exempt from filtering and would otherwise outrank them.
  const aLauncher = a.kind === 'custom-command';
  const bLauncher = b.kind === 'custom-command';
  if (aLauncher !== bLauncher) return aLauncher ? 1 : -1;
  if (a.isCurrent && !b.isCurrent) return -1;
  if (!a.isCurrent && b.isCurrent) return 1;
  if (a.available && !b.available) return -1;
  if (!a.available && b.available) return 1;
  return a.displayName.localeCompare(b.displayName);
}

export type ProviderAuthState = 'configured' | 'needs-signin';

/** Everything before the final path segment: `kilo/openrouter/free` → `kilo/openrouter`. */
export function modelProviderPrefix(id: string): string | undefined {
  const slash = id.lastIndexOf('/');
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/** The final path segment — the merge key: `kilo/openrouter/free` → `free`. */
export function modelBareId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash > 0 ? id.slice(slash + 1) : id;
}

/** The account that actually gates the call: the first path segment of the raw id. */
export function modelProviderAuthKey(id: string): string | undefined {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined;
}

const PROVIDER_TAG_COMPACTIONS: Record<string, string> = { 'github-copilot': 'copilot' };

/** Display tag for a provider prefix: its last segment, compacted for row width. */
export function compactProviderTag(prefix: string): string {
  const segments = prefix.split('/');
  const last = segments[segments.length - 1] ?? prefix;
  return PROVIDER_TAG_COMPACTIONS[last.toLowerCase()] ?? last;
}

function slugifyProviderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function envVarStem(envVar: string): string {
  return slugifyProviderName(envVar.replace(/_(API_KEY|KEY|TOKEN)$/i, ''));
}

function slugMatchesKey(slug: string, key: string): boolean {
  return slug === key || slug.startsWith(`${key}-`) || key.startsWith(`${slug}-`);
}

/**
 * Whether a credential fact from the tool's own auth listing backs the given
 * model-id segment. Oracle display names ("GitHub Copilot") reach id segments
 * through slugification plus dash-boundary containment ("Alibaba Coding Plan"
 * backs `alibaba/*`); env facts also match through the env var stem. A fact
 * that resolves to nothing simply does not contribute — it never manufactures
 * a claim about another provider.
 */
export function providerFactMatchesAuthKey(fact: CliProviderAuthFact, authKey: string): boolean {
  if (slugMatchesKey(slugifyProviderName(fact.provider), authKey)) return true;
  return fact.envVar !== undefined && slugMatchesKey(envVarStem(fact.envVar), authKey);
}

export function findProviderCredentialFacts(
  authKey: string,
  facts: readonly CliProviderAuthFact[],
): readonly CliProviderAuthFact[] {
  return facts.filter((fact) => providerFactMatchesAuthKey(fact, authKey));
}

export function findProviderCredentialFact(
  authKey: string,
  facts: readonly CliProviderAuthFact[],
): CliProviderAuthFact | undefined {
  return findProviderCredentialFacts(authKey, facts)[0];
}

/**
 * "Configured" is the OR of stored-oauth / stored-api / env credentials; a
 * provider with no matching fact needs sign-in. Callers gate on fact
 * availability first — absent facts must render no claim at all.
 */
export function resolveProviderAuthState(
  authKey: string,
  facts: readonly CliProviderAuthFact[],
): ProviderAuthState {
  return findProviderCredentialFact(authKey, facts) === undefined ? 'needs-signin' : 'configured';
}

export function assemblePickerDescriptors(): readonly RunnerPickerDescriptor[] {
  const meta: RunnerPickerDescriptor[] = [{ kind: 'custom-command' }, { kind: 'agent-sdk' }];
  const cli: RunnerPickerDescriptor[] = CLI_TOOL_IDS.map((id) => ({
    kind: 'cli',
    descriptor: CLI_TOOL_CATALOG[id],
  }));
  const api: RunnerPickerDescriptor[] = KNOWN_API_PROVIDER_IDS.map((id) => ({
    kind: 'api',
    descriptor: API_PROVIDER_CATALOG[id],
  }));
  return [...meta, ...cli, ...api];
}

export function buildPickerOptions(
  role: RunnerRole,
  descriptors: readonly RunnerPickerDescriptor[],
  detections: PickerDetectionSnapshot,
  currentConfig: PlannerConfig | ImplementerConfig | undefined,
  statusLens?: PickerStatusLens | undefined,
): PickerOption[] {
  const currentId = currentConfig !== undefined ? getRunnerDisplayName(currentConfig) : undefined;

  const options = descriptors.flatMap((entry) => {
    if (!descriptorSupportsRole(entry, role)) return [];

    const isCurrent = currentId === pickerDescriptorId(entry);
    const useConfiguredProviderOutcome =
      isCurrent || statusLens?.activeRunnerId === pickerDescriptorId(entry);
    if (entry.kind === 'cli') {
      return [projectCliOption(entry.descriptor, role, detections, isCurrent)];
    }
    if (entry.kind === 'api') {
      return [projectApiOption(entry.descriptor, role, detections, isCurrent)];
    }
    return [
      projectMetaOption(entry.kind, role, detections, isCurrent, useConfiguredProviderOutcome),
    ];
  });

  return options.toSorted(sortPickerOptions);
}
