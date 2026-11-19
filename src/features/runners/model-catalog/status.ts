import type {
  CliToolDetection,
  ProviderDetection,
} from '../../../core/discovery/detection/tool.js';
import { cliProviderAuthFacts } from '../../../core/discovery/detection/auth.js';
import type { CliReadinessState } from '../../../core/discovery/detection/tool.js';
import type { SavedCatalog, SavedCatalogOf } from '../../../core/discovery/catalog-read-merge.js';
import type { CliToolDescriptor } from '../../../core/runners/cli-tool/types.js';
import { servedProviders } from '../../../core/runners/route-auth.js';
import { cliReadinessRemediation, thenRecheck } from '../../../core/readiness/cli-remediation.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';

export type PickerStatusState = CliReadinessState;

export type PickerOptionStatus =
  | {
      state: 'ready';
      remediation: null;
      /**
       * Deduplicated provider names from the tool's own credential listing, or,
       * when it stores no credential, the providers its model listing serves.
       * Present only when a provider oracle ran; absent for presence-derived
       * readiness.
       */
      configuredProviders?: readonly string[] | undefined;
    }
  | { state: Exclude<PickerStatusState, 'ready'>; remediation: string };

/**
 * `cliTools` is required: an absent snapshot degrades every CLI row to
 * `unavailable`, so a caller that stops supplying detections must say so in the
 * type rather than silently emptying the picker.
 */
export type PickerDetectionSnapshot = Readonly<{
  cliTools: readonly CliToolDetection[];
  providers: readonly ProviderDetection[];
  /** Memory-only role/provider outcomes for the active configured connections. */
  providerOutcomes?: readonly ConfiguredProviderRuntime[] | undefined;
  /** Each CLI tool's own model listing, which tells a provider set up in the tool's config. */
  cliCatalog?: SavedCatalogOf | undefined;
  hasApiKeyOverride?: (provider: string) => boolean;
}>;

function findCliDetection(
  detections: PickerDetectionSnapshot,
  tool: string,
): CliToolDetection | undefined {
  return detections.cliTools.find((item) => item.tool === tool);
}

const PROVIDER_SIGN_IN_REMEDIATION = `Sign in or configure a provider, ${thenRecheck('picker')}. Free models require sign-in.`;

/**
 * A provider-dependent CLI's own credential listing outranks presence-derived
 * auth, but only on the auth axis: trust, compatibility, and availability
 * blockers stand. Absent facts (legacy cache, oracle fallback) resolve nothing
 * so the presence-derived diagnostic keeps governing. A tool that stores no
 * credential is ready on the providers its model listing serves.
 */
function providerFactStatus(
  descriptor: CliToolDescriptor,
  detection: CliToolDetection,
  catalog: SavedCatalog | null | undefined,
): PickerOptionStatus | undefined {
  if (descriptor.auth.kind !== 'provider-dependent') return undefined;
  const facts = cliProviderAuthFacts(detection.providerAuth);
  if (facts === undefined) return undefined;
  if (detection.diagnostic.state !== 'ready' && detection.diagnostic.state !== 'unauthenticated') {
    return undefined;
  }
  const providers =
    facts.length > 0
      ? [...new Set(facts.map((fact) => fact.provider))]
      : servedProviders({ tool: detection.tool, providerAuth: detection.providerAuth, catalog });
  if (providers.length === 0) {
    return { state: 'unauthenticated', remediation: PROVIDER_SIGN_IN_REMEDIATION };
  }
  return { state: 'ready', remediation: null, configuredProviders: providers };
}

export function deriveCliStatus(
  descriptor: CliToolDescriptor,
  detections: PickerDetectionSnapshot,
): PickerOptionStatus {
  const cliDetection = findCliDetection(detections, descriptor.id);
  if (!cliDetection) {
    return {
      state: 'unavailable',
      remediation: cliReadinessRemediation(
        {
          tool: descriptor.id,
          installedVersion: null,
          testedVersion: descriptor.compatibility.testedVersion,
          compatibility: 'not-checked',
        },
        'unavailable',
        'picker',
      ),
    };
  }
  const factStatus = providerFactStatus(
    descriptor,
    cliDetection,
    detections.cliCatalog?.(cliDetection.tool),
  );
  if (factStatus !== undefined) return factStatus;
  if (cliDetection.diagnostic.state === 'ready') {
    return { state: 'ready', remediation: null };
  }
  return {
    state: cliDetection.diagnostic.state,
    remediation: cliDetection.diagnostic.remediation,
  };
}

export function resolveCliVersion(
  tool: string,
  detections: PickerDetectionSnapshot,
): string | undefined {
  return findCliDetection(detections, tool)?.installedVersion ?? undefined;
}

export function isSelectable(status: PickerOptionStatus): boolean {
  return status.state === 'ready';
}
