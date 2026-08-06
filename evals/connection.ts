import {
  ADMITTED_API_PROVIDER_IDS,
  getApiProviderDescriptor,
  isApiProviderId,
} from '../src/core/providers/api-provider-catalog.js';
import { getKnownProviderBaseURL } from '../src/core/providers/catalog.js';
import { OLLAMA_LOCAL_API_KEY_REFERENCE } from '../src/core/providers/ollama-credential.js';
import { error } from '../src/utils/error.js';

const REPLAY_CREDENTIAL_PLACEHOLDER = 'eval-replay';

export function resolveEvalConnection(input: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  replay: boolean;
}): { baseUrl: string; apiKey: string } {
  const baseUrl = input.baseUrl.length > 0 ? input.baseUrl : resolveDefaultBaseUrl(input.provider);
  if (input.replay) {
    return {
      baseUrl,
      apiKey: input.apiKey.length > 0 ? input.apiKey : replayCredential(input.provider),
    };
  }
  if (input.apiKey.length === 0) {
    throw error(
      'eval-api-key-required',
      `Provider '${input.provider}' requires an API key outside replay mode; ` +
        'pass --api-key or set SPLITBRIEF_EVAL_API_KEY',
      { provider: input.provider },
    );
  }
  return { baseUrl, apiKey: input.apiKey };
}

function resolveDefaultBaseUrl(provider: string): string {
  if (!isApiProviderId(provider)) {
    throw error(
      'eval-provider-no-default-endpoint',
      `Provider '${provider}' has no default endpoint; ` +
        `pass --base-url or set SPLITBRIEF_EVAL_API_BASE, or use one of: ${ADMITTED_API_PROVIDER_IDS.join(', ')}`,
      { provider },
    );
  }
  return getKnownProviderBaseURL(provider);
}

function replayCredential(provider: string): string {
  const descriptor = getApiProviderDescriptor(provider);
  if (descriptor?.offering === 'local') {
    return descriptor.id === 'ollama' ? OLLAMA_LOCAL_API_KEY_REFERENCE : '';
  }
  return `${descriptor?.credentialPrefix ?? ''}${REPLAY_CREDENTIAL_PLACEHOLDER}`;
}
