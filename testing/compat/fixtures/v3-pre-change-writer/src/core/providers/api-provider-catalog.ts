import { typedEntries } from '../../utils/type-guards.js';
import type { RunnerBillingPosture } from '../runners/runner-billing.js';
import type { EndpointPolicy } from './endpoint-policy.js';

export const API_OFFERINGS = Object.freeze([
  'payg',
  'free-quota',
  'coding-subscription',
  'local',
] as const);

export type ApiOffering = (typeof API_OFFERINGS)[number];

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

export const EXISTING_API_PROVIDER_IDS = Object.freeze([
  'ollama',
  'lm-studio',
  'anthropic',
  'openrouter',
  'deepseek',
  'openai',
  'groq',
  'together',
] as const);

export const PASS_API_PROVIDER_IDS = Object.freeze(
  [] as const satisfies readonly (
    | 'mistral'
    | 'gemini'
    | 'cerebras'
    | 'zai'
    | 'mimo'
    | 'mimo-token-plan'
    | 'minimax'
    | 'moonshot'
    | 'dashscope'
    | 'llama-cpp'
  )[],
);

export const ADMITTED_API_PROVIDER_IDS = Object.freeze([
  ...EXISTING_API_PROVIDER_IDS,
  ...PASS_API_PROVIDER_IDS,
]);

export const FORBIDDEN_API_PROVIDER_IDS = Object.freeze([
  'kiro',
  'gemini-cli',
  'auggie',
  'junie',
  'cline',
  'qwen-coding-plan',
  'minimax-token-plan',
  'kimi-code',
  'zai-coding-plan',
  'alibaba-coding-plan',
  'siliconflow',
  'cloudflare',
  'github-models',
  'huggingface',
  'vllm',
  'localai',
  'local-openai',
  'sambanova',
  'nvidia-nim',
] as const);

export const API_PROVIDER_VERDICT_CANDIDATE_PATHS = Object.freeze([
  {
    id: 'mistral',
    source: 'src/engine/providers/candidates/mistral.ts',
    test: 'src/engine/providers/candidates/mistral.test.ts',
  },
  {
    id: 'gemini',
    source: 'src/engine/providers/candidates/gemini.ts',
    test: 'src/engine/providers/candidates/gemini.test.ts',
  },
  {
    id: 'cerebras',
    source: 'src/engine/providers/candidates/cerebras.ts',
    test: 'src/engine/providers/candidates/cerebras.test.ts',
  },
  {
    id: 'zai',
    source: 'src/engine/providers/candidates/zai.ts',
    test: 'src/engine/providers/candidates/zai.test.ts',
  },
  {
    id: 'mimo',
    source: 'src/engine/providers/candidates/mimo.ts',
    test: 'src/engine/providers/candidates/mimo.test.ts',
  },
  {
    id: 'mimo-token-plan',
    source: 'src/engine/providers/candidates/mimo-token-plan.ts',
    test: 'src/engine/providers/candidates/mimo-token-plan.test.ts',
  },
  {
    id: 'minimax',
    source: 'src/engine/providers/candidates/minimax.ts',
    test: 'src/engine/providers/candidates/minimax.test.ts',
  },
  {
    id: 'moonshot',
    source: 'src/engine/providers/candidates/moonshot.ts',
    test: 'src/engine/providers/candidates/moonshot.test.ts',
  },
  {
    id: 'dashscope',
    source: 'src/engine/providers/candidates/dashscope.ts',
    test: 'src/engine/providers/candidates/dashscope.test.ts',
  },
  {
    id: 'llama-cpp',
    source: 'src/engine/providers/llama-cpp.ts',
    test: 'src/engine/providers/llama-cpp.test.ts',
  },
] as const satisfies readonly {
  readonly id:
    | 'mistral'
    | 'gemini'
    | 'cerebras'
    | 'zai'
    | 'mimo'
    | 'mimo-token-plan'
    | 'minimax'
    | 'moonshot'
    | 'dashscope'
    | 'llama-cpp';
  readonly source: string;
  readonly test: string;
}[]);

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
