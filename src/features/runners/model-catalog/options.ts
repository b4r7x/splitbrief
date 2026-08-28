import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
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
  runnerRoleForActiveRole,
  seatPickerLane,
  type CliToolDescriptor,
  type RunnerRole,
  type ActiveRunnerRole,
  type SeatPickerRole,
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

/** The review seat's inherit row: confirming it clears `reviewer` instead of writing one. */
export interface InheritPlannerOption extends PickerOptionBase {
  kind: 'inherit-planner';
}

export type PickerOption = RunnerPickerOption | CustomCommandLauncherOption | InheritPlannerOption;

export const INHERIT_PLANNER_OPTION_ID = 'inherit-planner';

/**
 * The inherit row borrows the planner's posture because that is what the seat
 * will actually run, but never its model axis or its readiness: clearing the
 * `reviewer` block is an edit that always succeeds.
 */
export function inheritPlannerOption(
  input: Readonly<{ planner: PickerOption; isCurrent: boolean }>,
): InheritPlannerOption {
  return {
    id: INHERIT_PLANNER_OPTION_ID,
    displayName: 'Same as planner',
    kind: 'inherit-planner',
    roles: input.planner.roles,
    modelPolicy: 'none',
    modelCapability: deriveModelCatalogCapability('none'),
    billing: input.planner.billing,
    permissions: input.planner.permissions,
    status: { state: 'ready', remediation: null },
    available: true,
    ...(input.isCurrent ? { isCurrent: true } : {}),
  };
}

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

function descriptorSupportsRole(entry: RunnerPickerDescriptor, role: ActiveRunnerRole): boolean {
  return descriptorRoles(entry).includes(runnerRoleForActiveRole(role));
}

function projectCliOption(
  descriptor: CliToolDescriptor,
  role: ActiveRunnerRole,
  detections: PickerDetectionSnapshot,
  isCurrent: boolean,
): PickerOption {
  const policyRole = runnerRoleForActiveRole(role);
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
    modelPolicy: descriptor.modelPolicy[policyRole],
    modelCapability: deriveModelCatalogCapability(descriptor.modelPolicy[policyRole], true),
    billing: descriptor.billing,
    permissions: cliPermissions(descriptor, policyRole),
    status,
    available: isSelectable(status, 'cli'),
    ...(version ? { version } : {}),
    ...(isCurrent ? { isCurrent: true } : {}),
    ...(providerDependent ? { providerDependent: true } : {}),
  };
}

function projectApiOption(
  descriptor: ApiProviderDescriptor,
  role: ActiveRunnerRole,
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
    permissions: trustPermissions('api', runnerRoleForActiveRole(role)),
    status,
    available: isSelectable(status, 'api'),
    ...(isCurrent ? { isCurrent: true } : {}),
  };
}

function projectMetaOption(
  input: Readonly<{
    kind: 'custom-command' | 'agent-sdk';
    role: ActiveRunnerRole;
    detections: PickerDetectionSnapshot;
    isCurrent: boolean;
    useConfiguredProviderOutcome: boolean;
  }>,
): PickerOption {
  const { kind, role, detections, isCurrent } = input;
  const status = deriveMetaStatus({
    kind,
    detections,
    role,
    useConfiguredProviderOutcome: input.useConfiguredProviderOutcome,
  });

  const common = {
    id: kind,
    displayName: kind === 'custom-command' ? 'Custom command' : getProviderDisplayName(kind),
    roles: ['planner', 'implementer'] satisfies readonly RunnerRole[],
    modelPolicy: metaModelPolicy(kind),
    modelCapability: deriveModelCatalogCapability(metaModelPolicy(kind), kind === 'agent-sdk'),
    billing: metaBilling(kind),
    permissions: trustPermissions(
      kind === 'custom-command' ? 'shell' : kind,
      runnerRoleForActiveRole(role),
    ),
    status,
    available: isSelectable(status, kind),
    ...(isCurrent ? { isCurrent: true } : {}),
  };
  return kind === 'custom-command' ? { ...common, kind } : { ...common, kind };
}

export function sortPickerOptions(
  a: PickerOption,
  b: PickerOption,
  { filterActive }: { filterActive: boolean },
): number {
  // The launcher is filter-exempt, so it leads when idle and trails while filtering so matches sit under the cursor.
  const aLauncher = a.kind === 'custom-command';
  const bLauncher = b.kind === 'custom-command';
  if (aLauncher !== bLauncher) return aLauncher === filterActive ? 1 : -1;
  if (a.isCurrent && !b.isCurrent) return -1;
  if (!a.isCurrent && b.isCurrent) return 1;
  if (a.available && !b.available) return -1;
  if (!a.available && b.available) return 1;
  return a.displayName.localeCompare(b.displayName);
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
  role: SeatPickerRole,
  descriptors: readonly RunnerPickerDescriptor[],
  detections: PickerDetectionSnapshot,
  currentConfig: PlannerConfig | ImplementerConfig | undefined,
  statusLens?: PickerStatusLens | undefined,
  sort?: { filterActive: boolean } | undefined,
): PickerOption[] {
  const lane = seatPickerLane(role);
  const currentId = currentConfig !== undefined ? getRunnerDisplayName(currentConfig) : undefined;

  const options = descriptors.flatMap((entry) => {
    if (!descriptorSupportsRole(entry, lane)) return [];

    const isCurrent = currentId === pickerDescriptorId(entry);
    const useConfiguredProviderOutcome =
      isCurrent || statusLens?.activeRunnerId === pickerDescriptorId(entry);
    if (entry.kind === 'cli') {
      return [projectCliOption(entry.descriptor, lane, detections, isCurrent)];
    }
    if (entry.kind === 'api') {
      return [projectApiOption(entry.descriptor, lane, detections, isCurrent)];
    }
    return [
      projectMetaOption({
        kind: entry.kind,
        role: lane,
        detections,
        isCurrent,
        useConfiguredProviderOutcome,
      }),
    ];
  });

  return options.toSorted((a, b) =>
    sortPickerOptions(a, b, { filterActive: sort?.filterActive ?? false }),
  );
}
