export function includes<T>(arr: readonly T[], item: unknown): item is T {
  return (arr as readonly unknown[]).includes(item);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function narrowRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === 'object' && val !== null ? (val as Record<string, unknown>) : null;
}

export function typedKeys<T extends object>(obj: T): (keyof T)[] {
  return Object.keys(obj) as (keyof T)[];
}
