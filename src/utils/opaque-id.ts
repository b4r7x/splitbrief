export function createOpaqueIdFactory(prefix: string): (value: object) => string {
  const assigned = new WeakMap<object, string>();
  let next = 1;

  return (value: object): string => {
    const existing = assigned.get(value);
    if (existing !== undefined) return existing;

    const id = `${prefix}-${next}`;
    next += 1;
    assigned.set(value, id);
    return id;
  };
}
