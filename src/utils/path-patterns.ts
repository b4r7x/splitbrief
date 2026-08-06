import { isAbsolute, resolve } from 'node:path';

export const CONCRETE_FILE_PATH_PATTERN =
  /\b(?:[a-zA-Z][a-zA-Z0-9_-]*\/)+[a-zA-Z][a-zA-Z0-9._-]*\.[a-zA-Z]{1,5}\b/g;

function isPathToken(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('*');
}

export function scopePathPatterns(value: string): string[] {
  const backtickTokens = [...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((token): token is string => token !== undefined);
  const candidates =
    backtickTokens.length > 0
      ? backtickTokens
      : /\s/.test(value)
        ? [...value.matchAll(CONCRETE_FILE_PATH_PATTERN)].map((match) => match[0])
        : [value.trim()];
  return candidates.filter((candidate) => {
    const token = candidate.trim();
    return token.length > 0 && isPathToken(token);
  });
}

export function resolveFromProject(projectDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(projectDir, p);
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern === filePath) return true;

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(`${prefix}/`) || filePath === prefix;
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    const rest = filePath.slice(prefix.length + 1);
    return filePath.startsWith(`${prefix}/`) && !rest.includes('/');
  }

  if (pattern.startsWith('*.')) {
    return filePath.endsWith(pattern.slice(1));
  }

  if (pattern.includes('*')) {
    const starIdx = pattern.indexOf('*');
    const beforeStar = pattern.slice(0, starIdx);
    const afterStar = pattern.slice(starIdx + 1);
    return filePath.startsWith(beforeStar) && (afterStar === '' || filePath.endsWith(afterStar));
  }

  return false;
}
