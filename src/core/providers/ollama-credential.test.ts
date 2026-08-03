import { describe, expect, it } from 'vitest';
import {
  OLLAMA_LOCAL_API_KEY_REFERENCE,
  isOllamaLocalCredentialReference,
} from './ollama-credential.js';

describe('local Ollama credential reference', () => {
  it.each([
    undefined,
    OLLAMA_LOCAL_API_KEY_REFERENCE,
  ])('admits %s without borrowing the cloud credential namespace', (apiKey) => {
    expect(isOllamaLocalCredentialReference(apiKey)).toBe(true);
  });

  it.each([
    'local-inline-secret',
    'env:ARBITRARY_LOCAL_KEY',
    'env:OLLAMA_API_KEY',
  ])('rejects %s so local Ollama cannot alias a cloud credential', (apiKey) => {
    expect(isOllamaLocalCredentialReference(apiKey)).toBe(false);
  });
});
