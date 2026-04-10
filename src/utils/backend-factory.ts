export async function createBackend<T>(
  kind: string,
  registry: Record<string, () => Promise<T>>,
  errorContext: string,
): Promise<T> {
  const factory = registry[kind];
  if (!factory) {
    const supported = Object.keys(registry).join(', ');
    throw new Error(`Unknown ${errorContext}: ${kind}. Supported: ${supported}`);
  }
  return factory();
}
