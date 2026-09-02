import { isProviderId, type ProviderId } from '../schemas/enums.js';
import { CLI_TOOL_CATALOG, type CliToolDescriptor } from '../runners/cli-tool-catalog.js';
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
