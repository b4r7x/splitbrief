import type { ApiProviderId } from './api-catalog.js';

// The API providers that are not available now: their code stays, and no surface offers them.
// A hand-written config that names one still runs it. Delete an id here to bring it back.
export const HIDDEN_API_PROVIDER_IDS: readonly ApiProviderId[] = [
  'ollama',
  'lm-studio',
  'llama-cpp',
];
