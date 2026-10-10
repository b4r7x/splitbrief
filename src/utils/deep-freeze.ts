const frozen = new WeakSet<object>();

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || frozen.has(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
  frozen.add(value);
  return value;
}
