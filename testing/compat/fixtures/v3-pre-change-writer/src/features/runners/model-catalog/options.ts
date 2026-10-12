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
  | Readonly<{ kind: 'shell' | 'agent' | 'agent-sdk' }>;

export interface PickerOption {
  id: string;
  displayName: string;
  kind: RunnerKind;
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
  };
}

function projectApiOption(
  descriptor: ApiProviderDescriptor,
  role: RunnerRole,
  detections: PickerDetectionSnapshot,
  isCurrent: boolean,
): PickerOption {
  const status = deriveApiStatus(descriptor, detections);

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
  kind: 'shell' | 'agent' | 'agent-sdk',
  role: RunnerRole,
  detections: PickerDetectionSnapshot,
  isCurrent: boolean,
): PickerOption {
  const status = deriveMetaStatus(kind, detections);

  return {
    id: kind,
    displayName: getProviderDisplayName(kind),
    kind,
    roles: ['planner', 'implementer'],
    modelPolicy: metaModelPolicy(kind),
    modelCapability: deriveModelCatalogCapability(metaModelPolicy(kind), kind === 'agent-sdk'),
    billing: metaBilling(kind),
    permissions: trustPermissions(kind, role),
    status,
    available: isSelectable(status, kind),
    ...(isCurrent ? { isCurrent: true } : {}),
  };
}

function sortPickerOptions(a: PickerOption, b: PickerOption): number {
  if (a.isCurrent && !b.isCurrent) return -1;
  if (!a.isCurrent && b.isCurrent) return 1;
  if (a.available && !b.available) return -1;
  if (!a.available && b.available) return 1;
  return a.displayName.localeCompare(b.displayName);
}

export function assemblePickerDescriptors(): readonly RunnerPickerDescriptor[] {
  const meta: RunnerPickerDescriptor[] = [
    { kind: 'shell' },
    { kind: 'agent' },
    { kind: 'agent-sdk' },
  ];
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
): PickerOption[] {
  const currentId = currentConfig !== undefined ? getRunnerDisplayName(currentConfig) : undefined;

  const options = descriptors.flatMap((entry) => {
    if (!descriptorSupportsRole(entry, role)) return [];

    const isCurrent = currentId === pickerDescriptorId(entry);
    if (entry.kind === 'cli') {
      return [projectCliOption(entry.descriptor, role, detections, isCurrent)];
    }
    if (entry.kind === 'api') {
      return [projectApiOption(entry.descriptor, role, detections, isCurrent)];
    }
    return [projectMetaOption(entry.kind, role, detections, isCurrent)];
  });

  return options.toSorted(sortPickerOptions);
}
