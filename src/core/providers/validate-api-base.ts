export function validateApiBaseUrl(baseURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error('Invalid apiBase: must be an absolute URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Invalid apiBase: must not include credentials');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid apiBase: must use http or https');
  }
  return baseURL;
}
