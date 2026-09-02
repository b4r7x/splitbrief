import type OpenAI from 'openai';
import type { EndpointPolicyFetchOwner } from '../../core/providers/endpoint-policy.js';
import { endpointPolicyError, endpointPolicyFetch } from '../../core/providers/endpoint-policy.js';
import { createEndpointPolicyFetch } from '../../lib/http/policy-fetch.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { OpenAICompatPolicy } from './openai-compat-policy.js';
import { createClientFromProvider } from './client/connection.js';
import { extractOpenAIModelList, fetchModelList, isOpenAIModelList } from './client/request.js';
import type { ProviderDefWithMetadata, ProviderModelListOptions } from './types.js';
import { toStreamClient } from './openai-stream/client.js';
import type { StreamClient } from './openai-stream/request.js';
import {
  type ProviderConformanceFetchOptions,
  type UnregisteredProviderCandidateValue,
  bearerHeaders,
  credentialForContract,
  endpointForContract,
  environmentOf,
} from './conformance.js';

export interface UnregisteredOpenAICompatProvider
  extends ProviderDefWithMetadata,
    EndpointPolicyFetchOwner {
  readonly candidate: UnregisteredProviderCandidateValue;
  readonly policy: OpenAICompatPolicy;
  readonly client: OpenAI;
  readonly streamClient: StreamClient;
}

export function createUnregisteredOpenAICompatProvider(
  candidate: UnregisteredProviderCandidateValue,
  options: ProviderConformanceFetchOptions = {},
): UnregisteredOpenAICompatProvider {
  const environment = environmentOf(options);
  const endpoint = endpointForContract(candidate.rawContract, environment);
  const credential = credentialForContract(candidate.rawContract, environment);
  const policyFetch = createEndpointPolicyFetch(
    endpoint,
    endpointPolicyError.invalid,
    options.fetchImplementation ?? globalThis.fetch,
  );
  const provider: ProviderDefWithMetadata & EndpointPolicyFetchOwner = {
    [endpointPolicyFetch]: policyFetch,
    name: candidate.descriptor.id,
    baseURL: endpoint,
    apiKey: () => credential,
    isLocal: candidate.rawContract.offering === 'local',
    listModels: async (options?: ProviderModelListOptions) => {
      const headers = bearerHeaders(credential);
      return fetchModelList({
        endpoint: `${endpoint}/models`,
        ...(headers ? { headers } : {}),
        fetch: policyFetch,
        signal: options?.signal,
        extractModels: (body) => {
          if (!isOpenAIModelList(body)) return null;
          return extractOpenAIModelList(body, (item) => item.id);
        },
      });
    },
    listModelsWithMetadata: async (
      options?: ProviderModelListOptions,
    ): Promise<DetectedModel[]> => {
      const ids = await provider.listModels(options);
      return ids.map((id) => ({ id }));
    },
    detectContextLength: async (model: string): Promise<number | null> => {
      const known = candidate.knownModels.find(
        (entry) => entry.name === model || entry.aliases?.includes(model),
      );
      return known?.contextLength ?? null;
    },
  };
  const client = createClientFromProvider(provider);
  return {
    ...provider,
    candidate,
    policy: candidate.policy,
    client,
    streamClient: toStreamClient(client),
  };
}
