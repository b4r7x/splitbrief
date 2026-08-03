export const OLLAMA_LOCAL_API_KEY_REFERENCE = 'env:OLLAMA_LOCAL_API_KEY';

export function isOllamaLocalCredentialReference(apiKey: string | undefined): boolean {
  return apiKey === undefined || apiKey === OLLAMA_LOCAL_API_KEY_REFERENCE;
}
