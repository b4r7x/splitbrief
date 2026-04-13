// Sole sanctioned assertion location — these primitives enable assertion-free code elsewhere

export function includes<T>(arr: readonly T[], item: unknown): item is T {
  return (arr as readonly unknown[]).includes(item);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function narrowRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === 'object' && val !== null ? (val as Record<string, unknown>) : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

export function typedEntries<K extends string, V>(obj: Record<K, V>): [K, V][] {
  return Object.entries(obj) as [K, V][];
}

