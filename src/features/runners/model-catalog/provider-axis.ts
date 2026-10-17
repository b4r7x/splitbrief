/** Everything before the final path segment: `kilo/openrouter/free` → `kilo/openrouter`. */
export function modelProviderPrefix(id: string): string | undefined {
  const slash = id.lastIndexOf('/');
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/** The final path segment — the merge key: `kilo/openrouter/free` → `free`. */
export function modelBareId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash > 0 ? id.slice(slash + 1) : id;
}

/**
 * What that account calls the model, the listing's own `id` field: `kilo/kilo-auto/free` →
 * `kilo-auto/free`, `ollama-cloud/kimi-k3` → `kimi-k3`. An unprefixed id is its own.
 */
export function modelIdUnderProvider(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(slash + 1) : id;
}

const PROVIDER_TAG_COMPACTIONS: Record<string, string> = { 'github-copilot': 'copilot' };

/** Display tag for a provider prefix: its last segment, compacted for row width. */
export function compactProviderTag(prefix: string): string {
  const segments = prefix.split('/');
  const last = segments[segments.length - 1] ?? prefix;
  return PROVIDER_TAG_COMPACTIONS[last.toLowerCase()] ?? last;
}
