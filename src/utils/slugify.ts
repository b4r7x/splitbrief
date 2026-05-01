export function slugify(s: string, maxLength?: number): string {
  const result = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return maxLength !== undefined ? result.slice(0, maxLength) : result;
}
