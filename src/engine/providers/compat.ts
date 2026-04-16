import type { ProviderDef, ProviderOverrides } from './types.js';
import { createProviderShell, extractOpenAIModelList, fetchModelList, isOpenAIModelList, stripV1Suffix } from './client.js';

export function createOpenAICompatProvider(
  name: string,
  defaultBaseURL: string,
  envKeyName: string,
  isLocal: boolean,
  overrides?: ProviderOverrides,
): ProviderDef {
  const baseURL = overrides?.apiBase ?? defaultBaseURL;
  const shell = createProviderShell({ name, baseURL, isLocal });
  const apiKey = () => overrides?.apiKey ?? process.env[envKeyName] ?? '';

  return {
    name,
    baseURL,
    apiKey,
    isLocal,
    getLastError: shell.getLastError,

    listModels(): Promise<string[]> {
      const key = apiKey();
      const headers: Record<string, string> = {};
      if (key) headers['Authorization'] = `Bearer ${key}`;
      return fetchModelList({
        endpoint: `${stripV1Suffix(baseURL)}/v1/models`,
        headers,
        onError: shell.trackError,
        extractModels: (data) => isOpenAIModelList(data) ? extractOpenAIModelList(data, (m) => m.id) : null,
      });
    },
  };
}
