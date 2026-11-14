import { formatCost } from '../../../core/formatting.js';
import {
  type ApiOffering,
  API_PROVIDER_CATALOG,
  isApiProviderId,
} from '../../../core/providers/api-provider-catalog.js';
import { normalizeProviderEndpoint } from '../../../core/providers/endpoint-policy.js';
import { CLI_TOOL_CATALOG, cliToolIdForCommand } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { RunnerBillingPosture } from '../../../core/runners/runner-billing.js';
import type {
  BillingAttribution,
  ProviderRunMetadata,
  OfferingBillingPresentation,
} from '../../../core/schemas/cost.js';
import { type RunnerKind, META_PROVIDER_IDS } from '../../../core/schemas/enums.js';
import {
  REMOVED_API_PROVIDER_IDS,
  REMOVED_CLI_TOOL_IDS,
  REMOVED_RUNNER_KINDS,
} from '../../../core/schemas/runner/fields.js';

type ResolveProviderRunMetadataOpts = {
  tool: string;
  kind?: RunnerKind | undefined;
  normalizedEndpoint?: string | undefined;
};

// Meta seats and the identities this release removed carry no catalog
// descriptor. A resumed run still names them, so they must stay out of the
// custom-endpoint branch below rather than acquire an undated PAYG identity.
const DESCRIPTORLESS_TOOL_IDS = new Set<string>([
  ...META_PROVIDER_IDS,
  ...REMOVED_API_PROVIDER_IDS,
  ...REMOVED_CLI_TOOL_IDS,
  ...REMOVED_RUNNER_KINDS,
]);

function isCliToolId(tool: string): tool is CliToolId {
  return Object.hasOwn(CLI_TOOL_CATALOG, tool);
}

/** Whether a recorded identity is a CLI runner: its kind says so, or a legacy name did. */
export function isCliRunnerIdentity(kind: RunnerKind | undefined, id: string): boolean {
  return kind === 'cli' || (kind === undefined && isCliToolId(id));
}

export function cliOfferingFromBilling(billing: RunnerBillingPosture): ApiOffering {
  if (billing === 'local') return 'local';
  if (billing === 'subscription-included') return 'coding-subscription';
  return 'payg';
}

function defaultEndpointForApiProvider(providerId: keyof typeof API_PROVIDER_CATALOG): string {
  const policy = API_PROVIDER_CATALOG[providerId].endpointPolicy;
  if (policy.kind === 'fixed-origin') return policy.baseURL;
  if (policy.kind === 'loopback') return policy.defaultBaseURL;
  return '';
}

/**
 * A catalog descriptor states what a tool bills by default. That is a product
 * fact, never evidence about one run's invocations, so metadata resolved from
 * the catalog alone carries no attribution until the run's own calls supply one.
 */
export const UNATTRIBUTED_BILLING: BillingAttribution = { posture: 'unknown', basis: 'unknown' };
export const LEGACY_BILLING: BillingAttribution = {
  posture: 'unknown',
  basis: 'legacy-unattributed',
};

function apiDescriptorMetadata(
  providerId: keyof typeof API_PROVIDER_CATALOG,
  normalizedEndpoint: string | undefined,
): ProviderRunMetadata {
  const descriptor = API_PROVIDER_CATALOG[providerId];
  const endpointInput = normalizedEndpoint ?? defaultEndpointForApiProvider(providerId);
  const resolvedEndpoint =
    endpointInput.length > 0
      ? normalizeProviderEndpoint(descriptor.endpointPolicy, endpointInput)
      : '';
  return {
    service: descriptor.service,
    offering: descriptor.offering,
    normalizedEndpoint: resolvedEndpoint,
    billing: descriptor.billing,
    asOf: descriptor.asOf,
    billingAttribution: UNATTRIBUTED_BILLING,
  };
}

function cliDescriptorMetadata(tool: CliToolId): ProviderRunMetadata {
  const descriptor = CLI_TOOL_CATALOG[tool];
  return {
    service: descriptor.id,
    offering: cliOfferingFromBilling(descriptor.billing),
    normalizedEndpoint: `cli:${descriptor.command}`,
    billing: descriptor.billing,
    asOf: descriptor.compatibility.evidence.asOf,
    billingAttribution: UNATTRIBUTED_BILLING,
  };
}

/**
 * A user-declared custom endpoint: metered per token, with no catalog
 * descriptor to date its identity against.
 */
function customEndpointMetadata(
  tool: string,
  normalizedEndpoint: string | undefined,
): ProviderRunMetadata {
  return {
    service: tool,
    offering: 'payg',
    normalizedEndpoint: normalizedEndpoint ?? '',
    billing: 'api-metered',
    asOf: '',
    billingAttribution: UNATTRIBUTED_BILLING,
  };
}

/**
 * The billing identity one runner resolves to. A recorded kind decides the
 * branch before the name does: an API runner meters by model even when its name
 * is a CLI tool id, a CLI runner is never read as a custom endpoint, and a
 * shell or agent runner has no product descriptor at all. A runner with no
 * recorded kind keeps the name-only resolution for records written before kinds.
 */
export function resolveProviderRunMetadata(
  opts: ResolveProviderRunMetadataOpts,
): ProviderRunMetadata | undefined {
  const { tool, kind, normalizedEndpoint } = opts;

  if (kind === 'shell' || kind === 'agent') return undefined;
  if (kind === 'api') {
    return isApiProviderId(tool)
      ? apiDescriptorMetadata(tool, normalizedEndpoint)
      : customEndpointMetadata(tool, normalizedEndpoint);
  }
  if (kind === 'cli') {
    const id = cliToolIdForCommand(tool) ?? tool;
    return isCliToolId(id) ? cliDescriptorMetadata(id) : undefined;
  }

  if (isApiProviderId(tool)) return apiDescriptorMetadata(tool, normalizedEndpoint);
  if (isCliToolId(tool)) return cliDescriptorMetadata(tool);
  if (DESCRIPTORLESS_TOOL_IDS.has(tool)) return undefined;
  return customEndpointMetadata(tool, normalizedEndpoint);
}

export function describeOfferingBillingPresentation(
  metadata: ProviderRunMetadata,
  opts?: { hasUsage?: boolean | undefined; meteredCost?: number | undefined },
): OfferingBillingPresentation {
  const hasUsage = opts?.hasUsage ?? false;
  const meteredCost = opts?.meteredCost ?? 0;

  switch (metadata.offering) {
    case 'payg':
      return {
        costLabel: hasUsage ? formatCost(meteredCost) : metadata.billing,
        billingLabel: metadata.billing,
      };
    case 'coding-subscription':
      return {
        costLabel: 'subscription-included',
        billingLabel: 'subscription-included',
      };
    case 'free-quota':
      return {
        costLabel: 'variable quota',
        billingLabel: metadata.billing,
      };
    case 'local':
      return {
        costLabel: 'local',
        billingLabel: 'local',
      };
  }
}
