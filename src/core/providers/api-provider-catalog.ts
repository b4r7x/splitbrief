import { typedEntries } from '../../utils/type-guards.js';
import type { RunnerBillingPosture } from '../runners/runner-billing.js';
import { endpointPolicyError, type EndpointPolicy } from './endpoint-policy.js';

export const API_OFFERINGS = Object.freeze([
  'payg',
  'free-quota',
  'coding-subscription',
  'local',
] as const);

export type ApiOffering = (typeof API_OFFERINGS)[number];

export const API_PROVIDER_CATEGORIES = Object.freeze(['local-service', 'remote-api'] as const);

export type ApiProviderCategory = (typeof API_PROVIDER_CATEGORIES)[number];

export const API_PROVIDER_LOCALITIES = Object.freeze(['local', 'remote'] as const);

export type ApiProviderLocality = (typeof API_PROVIDER_LOCALITIES)[number];

export const API_AUTH_DISCOVERY_MODES = Object.freeze([
  'not-required',
  'optional-api-key-unverified',
  'api-key-unverified',
] as const);

export type ApiAuthDiscoveryMode = (typeof API_AUTH_DISCOVERY_MODES)[number];

export const API_MODEL_DISCOVERY_MODES = Object.freeze([
  'native-local-inventory',
  'account-model-list',
] as const);

export type ApiModelDiscoveryMode = (typeof API_MODEL_DISCOVERY_MODES)[number];

export const API_PREFLIGHT_FACTS = Object.freeze([
  'endpoint',
  'reachability',
  'authentication',
  'model-catalog',
  'model-runnability',
] as const);

export type ApiPreflightFact = (typeof API_PREFLIGHT_FACTS)[number];

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

export type ApiProviderAdmission =
  | Readonly<{ state: 'active' }>
  | Readonly<{
      state: 'pending-adapter';
      activation: 'createOllamaCloudProvider';
    }>;

export interface ApiProviderDescriptor<
  Id extends string = string,
  Roles extends readonly ApiRunnerRole[] = readonly ApiRunnerRole[],
  Offering extends ApiOffering = ApiOffering,
> {
  readonly id: Id;
  readonly displayName: string;
  readonly service: string;
  readonly offering: Offering;
  readonly category: ApiProviderCategory;
  readonly locality: ApiProviderLocality;
  readonly roles: Roles;
  readonly endpointPolicy: EndpointPolicy;
  readonly credentialEnv: string | null;
  readonly credentialPrefix: string | null;
  readonly authDiscoveryMode: ApiAuthDiscoveryMode;
  readonly modelDiscoveryMode: ApiModelDiscoveryMode;
  readonly mandatoryPreflightFacts: readonly ApiPreflightFact[];
  readonly billing: RunnerBillingPosture;
  readonly compatibility: CompatibilityQualification;
  readonly dataUse: DataUsePosture;
  readonly privacyURL: string;
  readonly termsURL: string;
  readonly asOf: string;
  readonly admission: ApiProviderAdmission;
}

function freezeEndpointPolicy(policy: EndpointPolicy): EndpointPolicy {
  if (policy.kind === 'allowed-https') {
    return Object.freeze({ ...policy, hosts: Object.freeze([...policy.hosts]) });
  }
  return Object.freeze({ ...policy });
}

function freezeAdmission(admission: ApiProviderAdmission): ApiProviderAdmission {
  if (admission.state === 'active') return Object.freeze({ state: 'active' });
  return Object.freeze({
    state: 'pending-adapter',
    activation: admission.activation,
  });
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
    mandatoryPreflightFacts: Object.freeze([...descriptor.mandatoryPreflightFacts]),
    admission: freezeAdmission(descriptor.admission),
  });
}

const LOCAL_API_PREFLIGHT_FACTS = Object.freeze([
  'endpoint',
  'reachability',
  'model-catalog',
  'model-runnability',
] as const satisfies readonly ApiPreflightFact[]);

const REMOTE_API_PREFLIGHT_FACTS = Object.freeze([
  'endpoint',
  'reachability',
  'authentication',
  'model-catalog',
  'model-runnability',
] as const satisfies readonly ApiPreflightFact[]);

export const API_PROVIDER_DECLARATIONS = Object.freeze({
  ollama: freezeDescriptor({
    id: 'ollama',
    displayName: 'Ollama',
    service: 'ollama',
    offering: 'local',
    category: 'local-service',
    locality: 'local',
    roles: ['implementer'],
    endpointPolicy: { kind: 'loopback', defaultBaseURL: 'http://localhost:11434/v1' },
    credentialEnv: null,
    credentialPrefix: null,
    authDiscoveryMode: 'not-required',
    modelDiscoveryMode: 'native-local-inventory',
    mandatoryPreflightFacts: LOCAL_API_PREFLIGHT_FACTS,
    billing: 'local',
    compatibility: 'verified',
    dataUse: 'local',
    privacyURL: 'https://ollama.com/privacy',
    termsURL: 'https://ollama.com/terms',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  'ollama-cloud': freezeDescriptor({
    id: 'ollama-cloud',
    displayName: 'Ollama Cloud',
    service: 'ollama',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://ollama.com' },
    credentialEnv: 'OLLAMA_API_KEY',
    credentialPrefix: null,
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'provider-dependent',
    compatibility: 'unverified',
    dataUse: 'provider-routed',
    privacyURL: 'https://ollama.com/privacy',
    termsURL: 'https://ollama.com/terms',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  'lm-studio': freezeDescriptor({
    id: 'lm-studio',
    displayName: 'LM Studio',
    service: 'lm-studio',
    offering: 'local',
    category: 'local-service',
    locality: 'local',
    roles: ['implementer'],
    endpointPolicy: { kind: 'loopback', defaultBaseURL: 'http://localhost:1234/v1' },
    credentialEnv: null,
    credentialPrefix: null,
    authDiscoveryMode: 'optional-api-key-unverified',
    modelDiscoveryMode: 'native-local-inventory',
    mandatoryPreflightFacts: LOCAL_API_PREFLIGHT_FACTS,
    billing: 'local',
    compatibility: 'verified',
    dataUse: 'local',
    privacyURL: 'https://lmstudio.ai/app-privacy',
    termsURL: 'https://lmstudio.ai/terms',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  anthropic: freezeDescriptor({
    id: 'anthropic',
    displayName: 'Anthropic',
    service: 'anthropic',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.anthropic.com/v1' },
    credentialEnv: 'ANTHROPIC_API_KEY',
    credentialPrefix: 'sk-ant-',
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'api-metered',
    compatibility: 'verified',
    dataUse: 'no-training',
    privacyURL: 'https://www.anthropic.com/legal/privacy',
    termsURL: 'https://www.anthropic.com/legal/commercial-terms',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  openrouter: freezeDescriptor({
    id: 'openrouter',
    displayName: 'OpenRouter',
    service: 'openrouter',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://openrouter.ai/api/v1' },
    credentialEnv: 'OPENROUTER_API_KEY',
    credentialPrefix: 'sk-or-',
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'provider-dependent',
    compatibility: 'verified',
    dataUse: 'provider-routed',
    privacyURL: 'https://openrouter.ai/docs/guides/privacy/provider-logging/',
    termsURL: 'https://openrouter.ai/terms',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  deepseek: freezeDescriptor({
    id: 'deepseek',
    displayName: 'DeepSeek',
    service: 'deepseek',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.deepseek.com/v1' },
    credentialEnv: 'DEEPSEEK_API_KEY',
    credentialPrefix: 'sk-',
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'api-metered',
    compatibility: 'unverified',
    dataUse: 'allowed-training',
    privacyURL: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
    termsURL:
      'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  openai: freezeDescriptor({
    id: 'openai',
    displayName: 'OpenAI',
    service: 'openai',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.openai.com/v1' },
    credentialEnv: 'OPENAI_API_KEY',
    credentialPrefix: 'sk-',
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'api-metered',
    compatibility: 'verified',
    dataUse: 'no-training',
    privacyURL: 'https://openai.com/policies/privacy-policy/',
    termsURL: 'https://openai.com/policies/business-terms/',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  groq: freezeDescriptor({
    id: 'groq',
    displayName: 'Groq',
    service: 'groq',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.groq.com/openai/v1' },
    credentialEnv: 'GROQ_API_KEY',
    credentialPrefix: 'gsk_',
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'provider-dependent',
    compatibility: 'verified',
    dataUse: 'non-retention',
    privacyURL: 'https://console.groq.com/docs/your-data',
    termsURL: 'https://groq.com/terms-of-use/',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
  together: freezeDescriptor({
    id: 'together',
    displayName: 'Together AI',
    service: 'together',
    offering: 'payg',
    category: 'remote-api',
    locality: 'remote',
    roles: ['planner', 'implementer'],
    endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.together.ai/v1' },
    credentialEnv: 'TOGETHER_API_KEY',
    credentialPrefix: null,
    authDiscoveryMode: 'api-key-unverified',
    modelDiscoveryMode: 'account-model-list',
    mandatoryPreflightFacts: REMOTE_API_PREFLIGHT_FACTS,
    billing: 'api-metered',
    compatibility: 'verified',
    dataUse: 'unreviewed',
    privacyURL: 'https://www.together.ai/privacy',
    termsURL: 'https://www.together.ai/terms-of-service',
    asOf: '2026-07-31',
    admission: { state: 'active' },
  }),
} satisfies Record<string, ApiProviderDescriptor>);

export const OLLAMA_CLOUD_API_PROVIDER_CANDIDATE = API_PROVIDER_DECLARATIONS['ollama-cloud'];

function activeProviderCatalog<Id extends string, Descriptor extends ApiProviderDescriptor<Id>>(
  declarations: Readonly<Record<Id, Descriptor>>,
): Readonly<Record<Id, Descriptor>> {
  for (const [, descriptor] of typedEntries(declarations)) {
    if (descriptor.admission.state !== 'active') throw endpointPolicyError.unsupported();
  }
  return declarations;
}

export type ApiProviderId = keyof typeof API_PROVIDER_DECLARATIONS;
export const API_PROVIDER_CATALOG = activeProviderCatalog(API_PROVIDER_DECLARATIONS);

export const ADMITTED_API_PROVIDER_IDS = Object.freeze(
  typedEntries(API_PROVIDER_CATALOG).map(([id]) => id),
);

export const PENDING_API_PROVIDER_CANDIDATE_IDS = Object.freeze(
  typedEntries(API_PROVIDER_DECLARATIONS)
    .filter(([, descriptor]) => descriptor.admission.state !== 'active')
    .map(([id]) => id),
);

export type ApiProviderIdForRole<Role extends ApiRunnerRole> = {
  [Id in ApiProviderId]: Role extends (typeof API_PROVIDER_CATALOG)[Id]['roles'][number]
    ? Id
    : never;
}[ApiProviderId];
export type LocalApiProviderId = {
  [Id in ApiProviderId]: (typeof API_PROVIDER_CATALOG)[Id]['offering'] extends 'local' ? Id : never;
}[ApiProviderId];
export type RemoteApiProviderId = Exclude<ApiProviderId, LocalApiProviderId>;

export const KNOWN_API_PROVIDER_IDS = Object.freeze(
  typedEntries(API_PROVIDER_CATALOG).map(([id]) => id),
);

export function isApiProviderId(value: string): value is ApiProviderId {
  return Object.hasOwn(API_PROVIDER_CATALOG, value);
}

export function getApiProviderDescriptor(
  id: string,
): (typeof API_PROVIDER_CATALOG)[ApiProviderId] | undefined {
  return isApiProviderId(id) ? API_PROVIDER_CATALOG[id] : undefined;
}

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
