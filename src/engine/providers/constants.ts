export const ANTHROPIC_API_VERSION = '2023-06-01';

export function stripV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

export function v1ModelsUrl(baseURL: string): string {
  return `${stripV1Suffix(baseURL)}/v1/models`;
}
