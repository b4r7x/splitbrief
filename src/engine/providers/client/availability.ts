import type { ProviderDef } from '../types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

export function describeProviderUnavailability(state: {
  isLocal: boolean;
  hasKey: boolean;
  lastError: string | undefined;
}): string {
  if (!state.isLocal && !state.hasKey) return 'no API key is configured';
  if (state.lastError) return state.lastError;
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
      try {
        hasKey = provider.apiKey().length > 0;
      } catch (err) {
        return toErrorMessage(err);
      }
      return describeProviderUnavailability({
        isLocal: provider.isLocal,
        hasKey,
        lastError: provider.getLastError?.(),
      });
    },
  };
}
