import { typedEntries } from '../../utils/type-guards.js';
import type { RunnerBillingPosture } from '../runners/runner-billing.js';
import type { EndpointPolicy } from './endpoint-policy.js';

export type ApiOffering = 'payg' | 'free-quota' | 'coding-subscription' | 'local';

export type CompatibilityQualification =
  | 'verified'
  | 'unverified'
  | 'incompatible'
  | 'beta'
  | 'unknown';

export type DataUsePosture =
  | 'local'
  | 'non-retention'
  | 'no-training'
  | 'opt-out'
  | 'region-sensitive'
  | 'provider-routed'
  | 'allowed-training'
  | 'unreviewed';

export type ApiRunnerRole = 'planner' | 'implementer';

export interface ApiProviderDescriptor<
  Id extends string = string,
  Roles extends readonly ApiRunnerRole[] = readonly ApiRunnerRole[],
  Offering extends ApiOffering = ApiOffering,
> {
  readonly id: Id;
  readonly service: string;
  readonly offering: Offering;
  readonly roles: Roles;
  readonly endpointPolicy: EndpointPolicy;
  readonly credentialEnv: string | null;
  readonly credentialPrefix: string | null;
  readonly billing: RunnerBillingPosture;
  readonly compatibility: CompatibilityQualification;
  readonly dataUse: DataUsePosture;
  readonly privacyURL: string;
  readonly termsURL: string;
  readonly asOf: string;
}

function freezeEndpointPolicy(policy: EndpointPolicy): EndpointPolicy {
  if (policy.kind === 'allowed-https') {
    return Object.freeze({ ...policy, hosts: Object.freeze([...policy.hosts]) });
  }
  return Object.freeze({ ...policy });
}

function freezeDescriptor<
  const Id extends string,
  const Roles extends readonly ApiRunnerRole[],
  const Offering extends ApiOffering,
>(
  descriptor: ApiProviderDescriptor<Id, Roles, Offering>,
): ApiProviderDescriptor<Id, Roles, Offering> {
  return Object.freeze({
    ...descriptor,
    roles: Object.freeze(descriptor.roles),
    endpointPolicy: freezeEndpointPolicy(descriptor.endpointPolicy),
  });
}

const catalog = {
  ollama: freezeDescriptor({
    id: 'ollama',
    service: 'ollama',
    offering: 'local',
    roles: ['implementer'],
    endpointPolicy: { kind: 'loopback', defaultBaseURL: 'http://localhost:11434/v1' },
    credentialEnv: 'OLLAMA_API_KEY',
    credentialPrefix: null,
    billing: 'local',
    compatibility: 'verified',
    dataUse: 'local',
    privacyURL: 'https://ollama.com/privacy',
    termsURL: 'https://ollama.com/terms',
    asOf: '2026-07-31',
  }),
  'lm-studio': freezeDescriptor({
    id: 'lm-studio',
    service: 'lm-studio',
    offering: 'local',
    roles: ['implementer'],
    endpointPolicy: { kind: 'loopback', defaultBaseURL: 'http://localhost:1234/v1' },
    credentialEnv: null,
    credentialPrefix: null,
    billing: 'local',
    compatibility: 'verified',
    dataUse: 'local',
    privacyURL: 'https://lmstudio.ai/app-privacy',
    termsURL: 'https://lmstudio.ai/terms',
    asOf: '2026-07-31',
  }),
  anthropic: freezeDescriptor({
    id: 'anthropic',
    service: 'anthropic',
    offering: 'payg',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.anthropic.com/v1' },
    credentialEnv: 'ANTHROPIC_API_KEY',
    credentialPrefix: 'sk-ant-',
    billing: 'api-metered',
    compatibility: 'verified',
    dataUse: 'no-training',
    privacyURL: 'https://www.anthropic.com/legal/privacy',
    termsURL: 'https://www.anthropic.com/legal/commercial-terms',
    asOf: '2026-07-31',
  }),
  openrouter: freezeDescriptor({
    id: 'openrouter',
    service: 'openrouter',
    offering: 'payg',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://openrouter.ai/api/v1' },
    credentialEnv: 'OPENROUTER_API_KEY',
    credentialPrefix: 'sk-or-',
    billing: 'provider-dependent',
    compatibility: 'verified',
    dataUse: 'provider-routed',
    privacyURL: 'https://openrouter.ai/docs/guides/privacy/provider-logging/',
    termsURL: 'https://openrouter.ai/terms',
    asOf: '2026-07-31',
  }),
  deepseek: freezeDescriptor({
    id: 'deepseek',
    service: 'deepseek',
    offering: 'payg',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.deepseek.com/v1' },
    credentialEnv: 'DEEPSEEK_API_KEY',
    credentialPrefix: 'sk-',
    billing: 'api-metered',
    compatibility: 'unverified',
    dataUse: 'allowed-training',
    privacyURL: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
    termsURL:
      'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html',
    asOf: '2026-07-31',
  }),
  openai: freezeDescriptor({
    id: 'openai',
    service: 'openai',
    offering: 'payg',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.openai.com/v1' },
    credentialEnv: 'OPENAI_API_KEY',
    credentialPrefix: 'sk-',
    billing: 'api-metered',
    compatibility: 'verified',
    dataUse: 'no-training',
    privacyURL: 'https://openai.com/policies/privacy-policy/',
    termsURL: 'https://openai.com/policies/business-terms/',
    asOf: '2026-07-31',
  }),
  groq: freezeDescriptor({
    id: 'groq',
    service: 'groq',
    offering: 'payg',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.groq.com/openai/v1' },
    credentialEnv: 'GROQ_API_KEY',
    credentialPrefix: 'gsk_',
    billing: 'provider-dependent',
    compatibility: 'verified',
    dataUse: 'non-retention',
    privacyURL: 'https://console.groq.com/docs/your-data',
    termsURL: 'https://groq.com/terms-of-use/',
    asOf: '2026-07-31',
  }),
  together: freezeDescriptor({
    id: 'together',
    service: 'together',
    offering: 'payg',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.together.xyz/v1' },
    credentialEnv: 'TOGETHER_API_KEY',
    credentialPrefix: null,
    billing: 'api-metered',
    compatibility: 'verified',
    dataUse: 'unreviewed',
    privacyURL: 'https://www.together.ai/privacy',
    termsURL: 'https://www.together.ai/terms-of-service',
    asOf: '2026-07-31',
  }),
} satisfies Record<string, ApiProviderDescriptor>;

export type ApiProviderId = keyof typeof catalog;
export type ApiProviderIdForRole<Role extends ApiRunnerRole> = {
  [Id in ApiProviderId]: Role extends (typeof catalog)[Id]['roles'][number] ? Id : never;
}[ApiProviderId];
export type LocalApiProviderId = {
  [Id in ApiProviderId]: (typeof catalog)[Id]['offering'] extends 'local' ? Id : never;
}[ApiProviderId];
export type RemoteApiProviderId = Exclude<ApiProviderId, LocalApiProviderId>;

export const API_PROVIDER_CATALOG: Readonly<typeof catalog> = Object.freeze(catalog);

export const KNOWN_API_PROVIDER_IDS = Object.freeze(
  typedEntries(API_PROVIDER_CATALOG).map(([id]) => id),
);

function apiProviderIdsForRole<Role extends ApiRunnerRole>(
  role: Role,
): readonly ApiProviderIdForRole<Role>[] {
  return Object.freeze(
    KNOWN_API_PROVIDER_IDS.filter((id): id is ApiProviderIdForRole<Role> => {
      const roles: readonly ApiRunnerRole[] = API_PROVIDER_CATALOG[id].roles;
      return roles.includes(role);
    }),
  );
}

export const PLANNER_API_PROVIDER_IDS = apiProviderIdsForRole('planner');
export const IMPLEMENTER_API_PROVIDER_IDS = apiProviderIdsForRole('implementer');
export const LOCAL_API_PROVIDER_IDS = Object.freeze(
  KNOWN_API_PROVIDER_IDS.filter(
    (id): id is LocalApiProviderId => API_PROVIDER_CATALOG[id].offering === 'local',
  ),
);
export const REMOTE_API_PROVIDER_IDS = Object.freeze(
  KNOWN_API_PROVIDER_IDS.filter(
    (id): id is RemoteApiProviderId => API_PROVIDER_CATALOG[id].offering !== 'local',
  ),
);
