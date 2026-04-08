import type { Config } from '../types/index.js';

export function getConfigValue(config: Config | Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function applyEdits(config: Config, edits: Record<string, unknown>): Config {
  const clone: Record<string, unknown> = structuredClone(config) as unknown as Record<string, unknown>;
  for (const [dotPath, value] of Object.entries(edits)) {
    const parts = dotPath.split('.');
    let current = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return clone as unknown as Config;
}
