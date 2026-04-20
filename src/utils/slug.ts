/** kebab-case, alphanumeric + hyphen only, collapsed, no leading/trailing hyphens. Max 40 chars. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
