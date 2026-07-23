import { describe, it, expect } from 'vitest';
import { describeProviderUnavailability } from './availability.js';

describe('describeProviderUnavailability', () => {
  it('reports a missing key for a remote provider with no key', () => {
    expect(
      describeProviderUnavailability({ isLocal: false, hasKey: false, lastError: undefined }),
    ).toBe('no API key is configured');
  });

  it('surfaces the tracked last error when a remote provider has a key', () => {
    expect(
      describeProviderUnavailability({ isLocal: false, hasKey: true, lastError: 'HTTP 401' }),
    ).toBe('HTTP 401');
  });

  it('reports an empty model list when a keyed remote provider tracked no error', () => {
    expect(
      describeProviderUnavailability({ isLocal: false, hasKey: true, lastError: undefined }),
    ).toBe('no models were returned');
  });

  it('reports an unreachable endpoint for a local provider with no tracked error', () => {
    expect(
      describeProviderUnavailability({ isLocal: true, hasKey: false, lastError: undefined }),
    ).toBe('the endpoint is unreachable');
  });
});
