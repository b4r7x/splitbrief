export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
