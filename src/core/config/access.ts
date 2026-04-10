import type { Config } from '../types/index.js';
import { ConfigSchema } from '../types/schemas/config.js';

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
  const clone = structuredClone(config);
  const root = clone as unknown as Record<string, unknown>;
  for (const [dotPath, value] of Object.entries(edits)) {
    const parts = dotPath.split('.');
    const lastPart = parts[parts.length - 1]!;
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      const existing = current[key];
      if (existing === undefined || existing === null || typeof existing !== 'object') {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[lastPart] = value;
  }
  return ConfigSchema.parse(clone);
}
