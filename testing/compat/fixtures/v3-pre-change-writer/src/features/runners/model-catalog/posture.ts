import type {
  CliModelPolicy,
  CliToolDescriptor,
  RunnerRole,
} from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerBillingPosture } from '../../../core/runners/runner-billing.js';
import { getRunnerTrustMeta } from '../../../core/schemas/runner-fields.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';

export type RunnerPermissionPosture = Readonly<{
  directWrite: boolean;
  network: boolean;
  shell: boolean;
  automaticApproval: boolean;
  sandbox: 'none' | 'cli-managed' | 'mode-dependent';
}>;

export type PickerModelPolicy = CliModelPolicy | 'per-call' | 'none';

export type ModelCatalogCapability = Readonly<{
  policy: PickerModelPolicy;
  requiresModel: boolean;
  allowsOmit: boolean;
  allowsCustom: boolean;
  showsDiscovered: boolean;
  allowsAutomatic: boolean;
}>;

export function deriveModelCatalogCapability(
  policy: PickerModelPolicy,
  automatic = false,
): ModelCatalogCapability {
  switch (policy) {
    case 'required':
      return {
        policy,
        requiresModel: true,
        allowsOmit: false,
        allowsCustom: true,
        showsDiscovered: true,
        allowsAutomatic: false,
      };
    case 'optional':
      return {
        policy,
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: true,
        showsDiscovered: true,
        allowsAutomatic: automatic,
      };
    case 'backend-default':
    case 'auto-only':
      return {
        policy,
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: false,
        showsDiscovered: false,
        allowsAutomatic: automatic,
      };
    case 'per-call':
      return {
        policy,
        requiresModel: true,
        allowsOmit: false,
        allowsCustom: true,
        showsDiscovered: true,
        allowsAutomatic: automatic,
      };
    case 'none':
      return {
        policy,
        requiresModel: false,
        allowsOmit: true,
        allowsCustom: false,
        showsDiscovered: false,
        allowsAutomatic: false,
      };
  }
}

export function cliPermissions(
  descriptor: CliToolDescriptor,
  role: RunnerRole,
): RunnerPermissionPosture {
  return {
    directWrite: descriptor.directWrite[role],
    network: descriptor.network[role],
    shell: descriptor.shell[role],
    automaticApproval: descriptor.automaticApproval[role],
    sandbox: descriptor.sandbox[role],
  };
}

export function trustPermissions(
  kind: Exclude<RunnerKind, 'cli'>,
  role: RunnerRole,
): RunnerPermissionPosture {
  const trust = getRunnerTrustMeta(role, { kind });
  return {
    directWrite: trust.mayWriteFilesDirectly,
    network: trust.mayUseNetwork,
    shell: trust.executesLocalCommand,
    automaticApproval: trust.autoAllowFlags.length > 0,
    sandbox: 'none',
  };
}

export function metaModelPolicy(kind: 'shell' | 'agent' | 'agent-sdk'): PickerModelPolicy {
  if (kind === 'agent-sdk') return 'per-call';
  return 'none';
}

export function metaBilling(kind: 'shell' | 'agent' | 'agent-sdk'): RunnerBillingPosture {
  if (kind === 'agent-sdk') return 'api-metered';
  return 'unknown';
}
