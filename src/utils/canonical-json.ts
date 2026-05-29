import { isRecord } from './type-guards.js';

export function canonicalJSON(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('canonicalJSON: undefined is not a valid JSON value');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJSON: NaN and Infinity are not valid JSON values');
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJSON(item));
    return `[${items.join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported type ${typeof value}`);
}
