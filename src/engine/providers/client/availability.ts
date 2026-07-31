import type { ProviderDef } from '../types.js';
import { sanitizeProviderDiagnostic } from './request.js';

export function describeProviderUnavailability(state: {
  isLocal: boolean;
  hasKey: boolean;
  lastError: string | undefined;
  credentialValues?: readonly (string | undefined)[] | undefined;
}): string {
  if (!state.isLocal && !state.hasKey) return 'no API key is configured';
  if (state.lastError)
    return sanitizeProviderDiagnostic(state.lastError, {
      credentialValues: state.credentialValues,
    });
  return state.isLocal ? 'the endpoint is unreachable' : 'no models were returned';
}

export function createProviderAvailability(provider: ProviderDef): {
  isAvailable: () => Promise<boolean>;
  unavailabilityReason: () => string | undefined;
} {
  return {
    async isAvailable() {
      try {
        if (!provider.isLocal && provider.apiKey().length === 0) return false;
        return (await provider.listModels()).length > 0;
      } catch {
        return false;
      }
    },

    unavailabilityReason() {
      let hasKey = false;
      let credential: string | undefined;
      try {
        credential = provider.apiKey();
        hasKey = credential.length > 0;
      } catch (err) {
        return sanitizeProviderDiagnostic(err);
      }
      let lastError: string | undefined;
      try {
        lastError = provider.getLastError?.();
      } catch (err) {
        return sanitizeProviderDiagnostic(err, {
          credentialValues: credential ? [credential] : undefined,
        });
      }
      return describeProviderUnavailability({
        isLocal: provider.isLocal,
        hasKey,
        lastError,
        credentialValues: credential ? [credential] : undefined,
      });
    },
  };
}
