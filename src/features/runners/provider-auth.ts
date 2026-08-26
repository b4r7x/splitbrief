import type { DetectedModel, ProviderDetection } from '../../core/discovery/detection.js';
import type {
  ApiProviderDescriptor,
  ApiProviderId,
} from '../../core/providers/api-provider-catalog.js';
import { stripProfileMetadata } from '../../core/config/accessors/implementer-profiles.js';
import { isInlineApiKey } from '../../core/config/credentials.js';
import { configuredReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ReviewerConfig } from '../../core/schemas/reviewer-config.js';
import { detectProviderCatalog } from '../../engine/providers/catalog-detection.js';
import type { ProviderCatalogFailureKind } from '../../engine/providers/types.js';
import { assertNever } from '../../utils/type-guards.js';
import type { PickerOptionStatus } from './model-catalog/status.js';

export type ProviderAuthAction = 'add-key' | 'replace-key';

export type ProviderKeyValidation =
  | Readonly<{ kind: 'valid'; models: readonly DetectedModel[] }>
  | Readonly<{ kind: 'invalid'; failure: ProviderCatalogFailureKind }>;

export interface ValidateProviderKeyInput {
  provider: ApiProviderId;
  apiKey: string;
  probe?: typeof detectProviderCatalog | undefined;
  signal?: AbortSignal | undefined;
}

export async function validateProviderKey(
  input: ValidateProviderKeyInput,
): Promise<ProviderKeyValidation> {
  const probe = input.probe ?? detectProviderCatalog;
  const outcome = await probe({
    provider: input.provider,
    configOverrides: { apiKey: input.apiKey },
    signal: input.signal,
  });
  // The diagnostic is dropped on purpose: downstream copy derives from the
  // failure enum alone, so the pasted key can never travel with the result.
  if (outcome.kind === 'failed') return { kind: 'invalid', failure: outcome.failure };
  return { kind: 'valid', models: outcome.models };
}

export function failureCopy(
  failure: ProviderCatalogFailureKind,
  descriptor: Pick<ApiProviderDescriptor, 'displayName'>,
): string {
  const name = descriptor.displayName;
  switch (failure) {
    case 'missing-credential':
      return `${name} received no key. Paste the full key and try again.`;
    case 'invalid-credential':
      return `${name} rejected the key. Paste a current key from your ${name} account.`;
    case 'policy-denied':
      return `${name} denied catalog access for this key. Check the key's permissions.`;
    case 'privacy-filtered':
      return `${name} privacy settings filtered catalog access. Review your ${name} privacy configuration.`;
    case 'guardrail-filtered':
      return `${name} guardrails filtered catalog access. Review your ${name} provider policy.`;
    case 'endpoint-invalid':
      return `The configured ${name} endpoint is invalid. Fix apiBase, then retry.`;
    case 'offline':
      return `${name} is unreachable. Check your network, then retry.`;
    case 'timeout':
      return `${name} timed out before confirming the key. Retry.`;
    case 'malformed':
      return `${name} returned an unreadable response. Retry.`;
    case 'request-failed':
      return `The ${name} request failed. Retry.`;
    default:
      return assertNever(failure);
  }
}

export function needsAuthAction(
  status: PickerOptionStatus,
  detection: ProviderDetection | undefined,
  descriptor: ApiProviderDescriptor,
): ProviderAuthAction | null {
  if (descriptor.compatibility !== 'verified') return null;
  if (descriptor.authDiscoveryMode !== 'api-key-unverified') return null;
  if (detection?.failure === 'invalid-credential') return 'replace-key';
  if (status.state !== 'unauthenticated') return null;
  return detection?.hasKey === true ? 'replace-key' : 'add-key';
}

export function redactKey(text: string, apiKey: string): string {
  const key = apiKey.trim();
  if (key === '') return text;
  return text.split(key).join('[redacted]');
}

function runnerHasInlineApiKey(
  runner: PlannerConfig | ImplementerConfig | ReviewerConfig,
): boolean {
  return (runner.kind === 'api' || runner.kind === 'agent-sdk') && isInlineApiKey(runner.apiKey);
}

export function configHasInlineApiKey(config: Config): boolean {
  const reviewer = configuredReviewerRunner(config);
  if (
    runnerHasInlineApiKey(config.planner) ||
    runnerHasInlineApiKey(config.implementer) ||
    (reviewer !== undefined && runnerHasInlineApiKey(reviewer))
  ) {
    return true;
  }
  const profiles = config.implementerProfiles?.profiles;
  if (profiles === undefined) return false;
  return Object.values(profiles).some((profile) =>
    runnerHasInlineApiKey(stripProfileMetadata(profile)),
  );
}

const COVERING_GITIGNORE_LINES = new Set([
  SPLITBRIEF_DIR,
  `${SPLITBRIEF_DIR}/`,
  `/${SPLITBRIEF_DIR}`,
  `/${SPLITBRIEF_DIR}/`,
  `${SPLITBRIEF_DIR}/**`,
  `/${SPLITBRIEF_DIR}/**`,
]);

export function gitignoreCoversSplitbrief(content: string | null): boolean {
  if (content === null) return false;
  return content
    .split('\n')
    .map((line) => line.trim())
    .some((line) => COVERING_GITIGNORE_LINES.has(line));
}
