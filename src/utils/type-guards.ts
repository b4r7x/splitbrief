import { error } from './error.js';

export function includes<T>(arr: readonly T[], item: unknown): item is T {
  return (arr as readonly unknown[]).includes(item);
}

export function assertNever(value: never): never {
  throw error('unexpected-value', `Unexpected value: ${String(value)}`, { value: String(value) });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function optionalString(
  value: unknown,
  options?: { trim?: boolean; nonEmpty?: boolean },
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = options?.trim ? value.trim() : value;
  if (options?.nonEmpty && candidate.length === 0) return undefined;
  return candidate;
}

export function narrowRecord(val: unknown): Record<string, unknown> | null {
  return isRecord(val) ? val : null;
}

export function typedEntries<K extends string, V>(obj: Readonly<Record<K, V>>): [K, V][] {
  return Object.entries(obj) as [K, V][];
}

export function mapRecord<K extends string, Value, Result>(
  record: Readonly<Record<K, Value>>,
  transform: (value: Value, key: K) => Result,
): Record<K, Result> {
  const entries: [K, Result][] = [];
  for (const [key, value] of typedEntries(record)) {
    entries.push([key, transform(value, key)]);
  }
  return Object.fromEntries(entries) as Record<K, Result>;
}
