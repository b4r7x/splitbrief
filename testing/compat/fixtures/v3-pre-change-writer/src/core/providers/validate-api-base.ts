import { error } from '../../utils/error.js';

export const apiBaseError = {
  notAbsolute: () => error('api-base-not-absolute', 'Invalid apiBase: must be an absolute URL'),
  hasCredentials: () =>
    error('api-base-has-credentials', 'Invalid apiBase: must not include credentials'),
  badProtocol: () => error('api-base-bad-protocol', 'Invalid apiBase: must use http or https'),
} as const;

export function validateApiBaseUrl(baseURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw apiBaseError.notAbsolute();
  }
  if (parsed.username || parsed.password) {
    throw apiBaseError.hasCredentials();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw apiBaseError.badProtocol();
  }
  return baseURL;
}
