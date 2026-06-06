import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';
import type { WorkflowMode } from '../../schemas/enums.js';
import { isRecord, narrowRecord } from '../../../utils/type-guards.js';

export function getWorkflowMode(config: Config): WorkflowMode {
  return config.workflow.mode ?? 'standard';
}

export function getConfigValue(config: Config | Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function applyEdits(config: Config, edits: Record<string, unknown>): Config {
  const clone = structuredClone(config);
  const root = narrowRecord(clone);
  if (!root) return config;
  for (const [dotPath, value] of Object.entries(edits)) {
    const parts = dotPath.split('.');
    const lastPart = parts[parts.length - 1];
    if (!lastPart) return config;
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!key) continue;
      const existing = current[key];
      if (!isRecord(existing)) {
        current[key] = {};
      }
      const next = narrowRecord(current[key]);
      if (!next) break;
      current = next;
    }
    current[lastPart] = value;
  }
  return ConfigSchema.parse(clone);
}
