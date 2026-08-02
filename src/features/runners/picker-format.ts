import { SOFT_SEP } from '../../components/separators.js';
import type { DataUsePosture } from '../../core/providers/api-provider-catalog.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RunnerPermissionPosture } from './model-catalog/posture.js';
import type { PickerOptionStatus } from './model-catalog/status.js';

export function isPickerItemDisabled(item: PickerOption): boolean {
  if (item.kind === 'shell' || item.kind === 'agent') return false;
  return !item.available;
}

export function formatPickerStatusLabel(status: PickerOptionStatus): string | undefined {
  switch (status.state) {
    case 'ready':
      return undefined;
    case 'unavailable':
      return 'Unavailable';
    case 'unauthenticated':
      return 'Auth required';
    case 'incompatible':
      return 'Incompatible';
    case 'untrusted':
      return 'Untrusted';
    case 'unverified':
      return 'Unverified';
    case 'disabled':
      return 'Disabled';
  }
}

export function formatBillingLabel(billing: RunnerBillingPosture): string {
  switch (billing) {
    case 'local':
      return 'Local billing';
    case 'subscription-included':
      return 'Subscription included';
    case 'api-metered':
      return 'API metered';
    case 'provider-dependent':
      return 'Provider dependent';
    case 'unknown':
      return 'Billing unknown';
  }
}

export function formatDataUseLabel(dataUse: DataUsePosture): string {
  switch (dataUse) {
    case 'local':
      return 'Local data';
    case 'non-retention':
      return 'No retention';
    case 'no-training':
      return 'No training';
    case 'opt-out':
      return 'Training opt-out';
    case 'region-sensitive':
      return 'Region sensitive';
    case 'provider-routed':
      return 'Provider routed';
    case 'allowed-training':
      return 'Training allowed';
    case 'unreviewed':
      return 'Data use unreviewed';
  }
}

export function formatPermissionLabels(permissions: RunnerPermissionPosture): string[] {
  const labels: string[] = [];
  if (permissions.directWrite) labels.push('Direct write');
  if (permissions.network) labels.push('Network');
  if (permissions.shell) labels.push('Shell');
  if (permissions.automaticApproval) labels.push('Auto approval');
  if (permissions.sandbox === 'cli-managed') labels.push('CLI sandbox');
  else if (permissions.sandbox === 'mode-dependent') labels.push('Sandbox varies');
  return labels;
}

export function formatToolPostureSummary(item: PickerOption): string {
  const parts = [...formatPermissionLabels(item.permissions), formatBillingLabel(item.billing)];
  if (item.dataUse) parts.push(formatDataUseLabel(item.dataUse));
  if (item.version) parts.push(item.version);
  return parts.filter(Boolean).join(SOFT_SEP);
}

export function formatModelCatalogGuidance(
  item: PickerOption,
  modelCount: number,
): { headline: string; detail: string | undefined } {
  const statusLabel = formatPickerStatusLabel(item.status);
  if (item.status.state !== 'ready') {
    return {
      headline: statusLabel ?? item.status.state,
      detail: item.status.remediation,
    };
  }

  const { modelCapability } = item;
  if (!modelCapability.showsDiscovered && !modelCapability.allowsCustom) {
    if (modelCapability.policy === 'auto-only' || modelCapability.policy === 'backend-default') {
      return { headline: 'Model chosen by the tool', detail: undefined };
    }
    if (modelCapability.policy === 'none') {
      return { headline: 'No model selection', detail: undefined };
    }
  }

  if (modelCount === 0) {
    return {
      headline: 'No models detected',
      detail: 'Press ctrl+r to refresh detection',
    };
  }

  const noun = modelCount === 1 ? 'model' : 'models';
  const headlineParts = [`${modelCount} ${noun} detected`];
  if (modelCapability.allowsCustom) headlineParts.push('custom models allowed');
  return { headline: headlineParts.join(SOFT_SEP), detail: undefined };
}

export function formatToolPreview(item: PickerOption, modelCount: number): string {
  const isCommandBased = item.kind === 'shell' || item.kind === 'agent';
  if (isCommandBased) {
    return [item.displayName, item.kind].join(SOFT_SEP);
  }

  const guidance = formatModelCatalogGuidance(item, modelCount);
  const parts = [item.displayName, item.kind, formatToolPostureSummary(item), guidance.headline];
  if (guidance.detail) parts.push(guidance.detail);
  return parts.filter(Boolean).join(SOFT_SEP);
}
