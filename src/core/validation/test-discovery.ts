export function isTestPatternSafe(pattern: string): boolean {
  if (!pattern || pattern.includes('..')) return false;
  if (pattern.includes('/') || pattern.includes('\\')) return false;
  return true;
}
