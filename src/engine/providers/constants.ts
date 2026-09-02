import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';

export const TRUNCATION_WARNING = `\n[${SPLITBRIEF_IDENTITY.displayName}] warning: response truncated at max_tokens — output is incomplete.\n`;

export function stripV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

export function v1ModelsUrl(baseURL: string): string {
  return `${stripV1Suffix(baseURL)}/v1/models`;
}
