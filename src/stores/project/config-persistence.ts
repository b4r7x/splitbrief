import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { toYaml } from '../../core/config/load/transform.js';
import { isRecord } from '../../utils/type-guards.js';

export interface SaveOptions {
  changedPaths?: readonly string[] | undefined;
}

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

function parseChangedPaths(paths: readonly string[] | undefined): Path[] {
  return (
    paths?.map((path) => path.split('.').filter(Boolean)).filter((path) => path.length > 0) ?? []
  );
}

function isPathPrefix(prefix: Path, path: Path): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((part, index) => path[index] === part);
}

function pathIntersectsChangedPath(path: Path, changedPaths: readonly Path[]): boolean {
  return changedPaths.some(
    (changedPath) => isPathPrefix(path, changedPath) || isPathPrefix(changedPath, path),
  );
}

interface PersistedValueArgs {
  persisted: unknown;
  effective: unknown;
  updated: unknown;
  path: Path;
  changedPaths: readonly Path[];
}

export function persistedValueForSave(args: PersistedValueArgs): unknown {
  const { persisted, effective, updated, path, changedPaths } = args;
  const equalToEffective = deepEqual(updated, effective);
  if (changedPaths.length === 0) {
    if (equalToEffective) return cloneValue(persisted);
  } else if (equalToEffective && !pathIntersectsChangedPath(path, changedPaths)) {
    return cloneValue(persisted);
  }

  if (!isRecord(updated) || !isRecord(effective)) return cloneValue(updated);

  const next: Record<string, unknown> = {};
  const persistedRecord = isRecord(persisted) ? persisted : {};
  for (const key of Object.keys(updated)) {
    next[key] = persistedValueForSave({
      persisted: persistedRecord[key],
      effective: effective[key],
      updated: updated[key],
      path: [...path, key],
      changedPaths,
    });
  }
  return next;
}

interface PersistedConfigArgs {
  persisted: Config;
  effective: Config;
  updated: Config;
  options?: SaveOptions | undefined;
}

export function persistedConfigForSave(args: PersistedConfigArgs): Config {
  const { persisted, effective, updated, options } = args;
  const changedPaths = parseChangedPaths(options?.changedPaths);
  if (changedPaths.length > 0 && deepEqual(updated, effective)) {
    const next = cloneConfig(persisted);
    for (const path of changedPaths) {
      const value = path.reduce<unknown>(
        (current, part) => (isRecord(current) ? current[part] : undefined),
        updated,
      );
      if (value !== undefined) {
        setPath(next, path, cloneValue(value));
      }
    }
    return next;
  }
  return ConfigSchema.parse(
    persistedValueForSave({ persisted, effective, updated, path: [], changedPaths }),
  );
}

function readPath(source: Config, path: Path): unknown {
  return path.reduce<unknown>(
    (current, part) => (isRecord(current) ? current[part] : undefined),
    source,
  );
}

function snakeEdit(camelPath: Path, value: unknown): ConfigEdit {
  let nested: Record<string, unknown> = {};
  for (let i = camelPath.length - 1; i >= 0; i--) {
    const segment = camelPath[i];
    if (segment === undefined) continue;
    nested = { [segment]: i === camelPath.length - 1 ? value : nested };
  }
  const transformed = toYaml(nested);
  const snakePath: string[] = [];
  let cursor: unknown = transformed;
  for (let i = 0; i < camelPath.length; i++) {
    if (!isRecord(cursor)) break;
    const key = Object.keys(cursor)[0];
    if (key === undefined) break;
    snakePath.push(key);
    cursor = cursor[key];
  }
  return { path: snakePath, value: cursor };
}

export function editsForSave(updated: Config, options?: SaveOptions): ConfigEdit[] {
  const changedPaths = parseChangedPaths(options?.changedPaths);
  return changedPaths.map((path) => snakeEdit(path, readPath(updated, path)));
}

function setPath(target: Record<string, unknown>, path: Path, value: unknown): void {
  let current: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!key) return;
    const child = current[key];
    if (isRecord(child)) {
      current = child;
    } else {
      const next: Record<string, unknown> = {};
      current[key] = next;
      current = next;
    }
  }
  const last = path.at(-1);
  if (last) current[last] = value;
}
