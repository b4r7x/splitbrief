import { narrowRecord } from '../../../utils/type-guards.js';
import { HOOK_EVENTS } from '../../schemas/hooks.js';

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

const HOOK_EVENT_KEYS: ReadonlySet<string> = new Set(HOOK_EVENTS);

function transformHookKey(key: string, path: readonly string[]): string {
  if (path.length === 1) {
    const hookEvent = camelToSnake(key);
    return HOOK_EVENT_KEYS.has(hookEvent) ? hookEvent : key;
  }
  return camelToSnake(key);
}

function transformKey(
  key: string,
  keyFn: (key: string) => string,
  path: readonly string[],
): string {
  if (path[0] === 'hooks') return transformHookKey(key, path);
  return keyFn(key);
}

function transformKeys(
  obj: unknown,
  keyFn: (key: string) => string,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(obj)) return obj.map((item) => transformKeys(item, keyFn, path));
  const record = narrowRecord(obj);
  if (record !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const nextKey = transformKey(key, keyFn, path);
      result[nextKey] = transformKeys(value, keyFn, [...path, nextKey]);
    }
    return result;
  }
  return obj;
}

/**
 * The key the loader reads a YAML key as, beneath a parent path already in its loaded spelling.
 * `outputFormat` and `output_format` load as one key; where a map carries both, the later wins.
 */
export function loadedKey(key: string, loadedPath: readonly string[]): string {
  return transformKey(key, snakeToCamel, loadedPath);
}

export function fromYaml(obj: unknown): Record<string, unknown> {
  return narrowRecord(transformKeys(obj, snakeToCamel)) ?? {};
}

export function toYaml(obj: Record<string, unknown>): Record<string, unknown> {
  return narrowRecord(transformKeys(obj, camelToSnake)) ?? {};
}
