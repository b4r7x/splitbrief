export function dispatchRunner<T, A, K extends string>(
  kind: K,
  factories: Record<K, (arg: A) => T>,
  role: string,
  arg: A,
): T {
  const factory = factories[kind];
  if (!factory) {
    const supported = Object.keys(factories).join(', ');
    throw new Error(`Unknown ${role} kind: ${kind}. Supported: ${supported}`);
  }
  return factory(arg);
}
