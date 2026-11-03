import { startDeadline } from '../../../utils/with-timeout.js';
import { CLI_PROBE_TIMEOUT_MS } from '../../constants.js';
import { trackProbe } from '../../probe-activity.js';
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

/**
 * `signal` is the run's: a stop during the check rejects instead of calling the
 * provider unavailable.
 */
export function createProviderAvailability(
  provider: ProviderDef,
  signal?: AbortSignal | undefined,
): {
  isAvailable: () => Promise<boolean>;
  unavailabilityReason: () => string | undefined;
} {
  let timedOut = false;
  return {
    async isAvailable() {
      timedOut = false;
      const deadline = startDeadline(signal, CLI_PROBE_TIMEOUT_MS);
      try {
        if (!provider.isLocal && provider.apiKey().length === 0) return false;
        const models = await trackProbe({ provider: provider.name, check: 'model list' }, () =>
          provider.listModels({ signal: deadline.signal }),
        );
        return models.length > 0;
      } catch (cause) {
        if (signal?.aborted === true) throw cause;
        timedOut = deadline.expired();
        return false;
      } finally {
        deadline.clear();
      }
    },

    unavailabilityReason() {
      if (timedOut) return 'the model list did not answer in time';
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
