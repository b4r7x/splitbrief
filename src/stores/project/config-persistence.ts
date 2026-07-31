import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { toYaml } from '../../core/config/load/transform.js';
import { isRecord } from '../../utils/type-guards.js';

export type Path = readonly string[];

export interface ConfigEdit {
  path: Path;
  value: unknown;
}

export function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

interface PersistedValueArgs {
  persisted: unknown;
  effective: unknown;
  updated: unknown;
}

export function persistedValueForSave(args: PersistedValueArgs): unknown {
  const { persisted, effective, updated } = args;
  if (deepEqual(updated, effective)) return cloneValue(persisted);

  if (!isRecord(updated) || !isRecord(effective)) return cloneValue(updated);

  const next: Record<string, unknown> = {};
  const persistedRecord = isRecord(persisted) ? persisted : {};
  for (const key of Object.keys(updated)) {
    next[key] = persistedValueForSave({
      persisted: persistedRecord[key],
      effective: effective[key],
      updated: updated[key],
    });
  }
  return next;
}

interface PersistedConfigArgs {
  persisted: Config;
  effective: Config;
  updated: Config;
}

export function persistedConfigForSave(args: PersistedConfigArgs): Config {
  const { persisted, effective, updated } = args;
  return ConfigSchema.parse(persistedValueForSave({ persisted, effective, updated }));
}

function deriveValueEdits(before: unknown, after: unknown, path: Path): ConfigEdit[] {
  if (deepEqual(before, after)) return [];
  if (!isRecord(before) || !isRecord(after)) {
    return [{ path, value: cloneValue(after) }];
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => deriveValueEdits(before[key], after[key], [...path, key]));
}

export function deriveConfigEdits(before: Config, after: Config): ConfigEdit[] {
  return deriveValueEdits(toYaml(before), toYaml(after), []);
}

export function editsForSave(before: Config, after: Config): ConfigEdit[] {
  return deriveConfigEdits(before, after);
}
