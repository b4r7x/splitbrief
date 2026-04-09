import type { ProviderDef, ProviderOverrides } from './types.js';
import { extractOpenAIModelList, fetchModelList, stripV1Suffix } from './client.js';

export function createOpenAICompatProvider(
  name: string,
  defaultBaseURL: string,
  envKeyName: string,
  isLocal: boolean,
  overrides?: ProviderOverrides,
): ProviderDef {
  const baseURL = overrides?.apiBase || defaultBaseURL;
  const apiKey = () => overrides?.apiKey || process.env[envKeyName] || '';

  return {
    name,
    baseURL,
    apiKey,
    isLocal,

    listModels(): Promise<string[]> {
      const headers: Record<string, string> = {};
      const key = apiKey();
      if (key) headers['Authorization'] = `Bearer ${key}`;
      return fetchModelList(`${stripV1Suffix(baseURL)}/v1/models`, (data) => extractOpenAIModelList(data, (m) => m.id), headers);
    },
  };
}
