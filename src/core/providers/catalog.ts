import { isProviderId, RUNNER_KINDS, type ProviderId, type RunnerKind } from '../schemas/enums.js';
import {
  CLI_TOOL_CATALOG,
  cliToolIdForCommand,
  type CliToolDescriptor,
} from '../runners/cli-tool-catalog.js';
import { mapRecord } from '../../utils/type-guards.js';
import {
  API_PROVIDER_CATALOG,
  isApiProviderId,
  type ApiProviderDescriptor,
  type ApiProviderId,
} from './api-provider-catalog.js';
import { endpointPolicyError } from './endpoint-policy.js';

export type ProviderCategory = 'cli' | 'remote-api' | 'local-service' | 'custom';

export interface ProviderInfo {
  id: string;
  displayName: string;
  category: ProviderCategory;
  locality?: 'local' | 'remote';
  baseURL?: string;
  isLocal?: boolean;
  isSubscription?: boolean;
  apiKeyEnv?: string;
}

function defaultBaseURL(descriptor: ApiProviderDescriptor): string | undefined {
  switch (descriptor.endpointPolicy.kind) {
    case 'fixed-origin':
      return descriptor.endpointPolicy.baseURL;
    case 'loopback':
      return descriptor.endpointPolicy.defaultBaseURL;
    case 'allowed-https':
      return undefined;
  }
}

function providerInfoFromApiDescriptor(descriptor: ApiProviderDescriptor): ProviderInfo {
  const baseURL = defaultBaseURL(descriptor);
  return Object.freeze({
    id: descriptor.id,
    displayName: descriptor.displayName,
    category: descriptor.category,
    locality: descriptor.locality,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(descriptor.locality === 'local' ? { isLocal: true } : {}),
    ...(descriptor.credentialEnv === null ? {} : { apiKeyEnv: descriptor.credentialEnv }),
  });
}

function providerInfoFromCliDescriptor(descriptor: CliToolDescriptor): ProviderInfo {
  return Object.freeze({
    id: descriptor.id,
    displayName: descriptor.displayName,
    category: descriptor.category,
    ...(descriptor.isSubscription ? { isSubscription: true } : {}),
  });
}

export type KnownProviderBaseURLs = Readonly<Record<ApiProviderId, string>>;

function providerBaseURLs(): KnownProviderBaseURLs {
  return Object.freeze(
    mapRecord(API_PROVIDER_CATALOG, (descriptor) => {
      const baseURL = defaultBaseURL(descriptor);
      if (baseURL === undefined) throw endpointPolicyError.unsupported();
      return baseURL;
    }),
  );
}

function apiProviderInfoCatalog(): Readonly<Record<ApiProviderId, ProviderInfo>> {
  return Object.freeze(
    mapRecord(API_PROVIDER_CATALOG, (descriptor) => providerInfoFromApiDescriptor(descriptor)),
  );
}

export const KNOWN_PROVIDER_BASE_URLS = providerBaseURLs();

export function getKnownProviderBaseURL(providerId: ApiProviderId): string {
  const descriptor = API_PROVIDER_CATALOG[providerId];
  if (descriptor === undefined) throw endpointPolicyError.unsupported();
  const baseURL = defaultBaseURL(descriptor);
  if (baseURL === undefined) throw endpointPolicyError.unsupported();
  return baseURL;
}

const META_PROVIDER_INFO = Object.freeze({
  shell: Object.freeze({
    id: 'shell',
    displayName: 'Custom Shell',
    category: 'custom',
  }),
  agent: Object.freeze({
    id: 'agent',
    displayName: 'Agent',
    category: 'custom',
  }),
} satisfies Record<string, ProviderInfo>);

export const PROVIDER_CATALOG: Readonly<Record<ProviderId, ProviderInfo>> = Object.freeze({
  'claude-code': providerInfoFromCliDescriptor(CLI_TOOL_CATALOG['claude-code']),
  codex: providerInfoFromCliDescriptor(CLI_TOOL_CATALOG.codex),
  opencode: providerInfoFromCliDescriptor(CLI_TOOL_CATALOG.opencode),
  copilot: providerInfoFromCliDescriptor(CLI_TOOL_CATALOG.copilot),
  'kilo-code': providerInfoFromCliDescriptor(CLI_TOOL_CATALOG['kilo-code']),
  cursor: providerInfoFromCliDescriptor(CLI_TOOL_CATALOG.cursor),
  'command-code': providerInfoFromCliDescriptor(CLI_TOOL_CATALOG['command-code']),
  antigravity: providerInfoFromCliDescriptor(CLI_TOOL_CATALOG.antigravity),
  ...apiProviderInfoCatalog(),
  ...META_PROVIDER_INFO,
});

export function resolveDefaultApiBase(providerId: string): string | null {
  return isApiProviderId(providerId) ? getKnownProviderBaseURL(providerId) : null;
}

export function isSameOrigin(candidate: string, expected: string): boolean {
  try {
    return new URL(candidate).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export function getProviderDisplayName(id: string): string {
  if (!isProviderId(id)) return id;
  return providerInfo(id).displayName;
}

function isRunnerKind(value: string): value is RunnerKind {
  return (RUNNER_KINDS as readonly string[]).includes(value);
}

/**
 * The display word for one runner identity, decided by its backend kind. A
 * catalogued API provider keeps its display name and a custom API provider —
 * even one named after a CLI tool — stays literal; a CLI call named by its
 * command resolves through the tool it starts. Canonical shell and agent ids
 * use their catalog labels; other command names stay literal. An identity
 * recorded without a kind keeps the merged-catalog resolution for older records.
 */
export function getRunnerIdentityDisplayName(kind: RunnerKind | undefined, id: string): string {
  if (kind === 'api') return isApiProviderId(id) ? getProviderDisplayName(id) : id;
  if (kind === 'cli') return getProviderDisplayName(cliToolIdForCommand(id) ?? id);
  if (kind === 'shell' || kind === 'agent') return id === kind ? getProviderDisplayName(id) : id;
  return getProviderDisplayName(id);
}

/**
 * The kind-qualified identity one recorded runner is keyed by, so `api:opencode`
 * and `cli:opencode` are two runners and never one.
 */
export function runnerIdentityKey(kind: RunnerKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Reads a key back. A name that carries no kind prefix — including a custom
 * name that itself contains a colon — is a legacy name-only identity.
 */
export function parseRunnerIdentityKey(key: string): { kind: RunnerKind | undefined; id: string } {
  const separator = key.indexOf(':');
  if (separator > 0 && separator < key.length - 1) {
    const kind = key.slice(0, separator);
    if (isRunnerKind(kind)) return { kind, id: key.slice(separator + 1) };
  }
  return { kind: undefined, id: key };
}

export function getProviderBaseURL(id: string): string {
  if (!isProviderId(id)) return '';
  return providerInfo(id).baseURL ?? '';
}

export function isProviderLocal(id: string): boolean {
  if (!isProviderId(id)) return false;
  return Boolean(providerInfo(id).isLocal);
}

export function isProviderSubscription(id: string): boolean {
  if (!isProviderId(id)) return false;
  return Boolean(providerInfo(id).isSubscription);
}

function getProviderApiKeyEnv(id: string): string | undefined {
  if (!isProviderId(id)) return undefined;
  return providerInfo(id).apiKeyEnv;
}

function providerInfo(id: ProviderId): ProviderInfo {
  const info = PROVIDER_CATALOG[id];
  if (info === undefined) throw endpointPolicyError.unsupported();
  return info;
}

export function hasApiKey(providerId: string): boolean {
  const envVar = getProviderApiKeyEnv(providerId);
  return Boolean(envVar && process.env[envVar]);
}
