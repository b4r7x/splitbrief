import { slugify } from './slugify.js';

/** kebab-case, alphanumeric + hyphen only, collapsed, no leading/trailing hyphens. Max 40 chars. */
export function slug(input: string): string {
  return slugify(input).slice(0, 40);
}
