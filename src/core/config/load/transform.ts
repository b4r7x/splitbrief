import { narrowRecord } from '../../../utils/type-guards.js';

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

const HOOK_EVENT_KEYS = new Set([
  'pre_planning',
  'post_planning',
  'pre_task',
  'post_task',
  'pre_validation',
  'post_validation',
  'pre_commit',
  'post_commit',
  'pre_escalation',
  'pre_compact',
  'on_error',
  'on_complete',
]);

function transformHookKey(key: string, path: readonly string[]): string {
  if (path.length === 1) {
    const hookEvent = camelToSnake(key);
    return HOOK_EVENT_KEYS.has(hookEvent) ? hookEvent : key;
  }
  if (path.length === 2 && path[1] === 'builtin') return key;
  return camelToSnake(key);
}

function transformKey(key: string, keyFn: (key: string) => string, path: readonly string[]): string {
  if (path[0] === 'hooks') return transformHookKey(key, path);
  if (path.length === 2 && path[0] === 'approval' && path[1] === 'tiers') return camelToSnake(key);
  return keyFn(key);
}

function transformKeys(
  obj: unknown,
  keyFn: (key: string) => string,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(obj)) return obj.map(item => transformKeys(item, keyFn, path));
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

export function fromYaml(obj: unknown): Record<string, unknown> {
  return narrowRecord(transformKeys(obj, snakeToCamel)) ?? {};
}

export function toYaml(obj: Record<string, unknown>): Record<string, unknown> {
  return narrowRecord(transformKeys(obj, camelToSnake)) ?? {};
}
