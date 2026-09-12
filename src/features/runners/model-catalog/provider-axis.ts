import type { CliProviderAuthFact } from '../../../core/discovery/detection.js';

export type ProviderAuthState = 'configured' | 'needs-signin';

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
 * The leading segment every namespaced row of a listing shares — `kilo` on a Kilo listing. The
 * Tools column beside the list already names the tool, so repeating it on every row costs cells the
 * model's own name needs. Undefined unless at least two three-segment ids agree on one.
 */
export function sharedModelNamespace(ids: readonly string[]): string | undefined {
  let shared: string | undefined;
  let agreed = 0;
  for (const id of ids) {
    const segments = id.split('/');
    if (segments.length < 3) continue;
    const first = segments[0];
    if (first === undefined || first === '') return undefined;
    if (shared === undefined) shared = first;
    else if (shared !== first) return undefined;
    agreed += 1;
  }
  return agreed >= 2 ? shared : undefined;
}

/** Drops that shared segment, and only while what is left is still a namespaced id. */
export function stripModelNamespace(id: string, namespace: string | undefined): string {
  if (namespace === undefined) return id;
  const prefix = `${namespace}/`;
  if (!id.startsWith(prefix)) return id;
  const rest = id.slice(prefix.length);
  return rest.includes('/') ? rest : id;
}

/** The account that actually gates the call: the first path segment of the raw id. */
export function modelProviderAuthKey(id: string): string | undefined {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined;
}

const PROVIDER_TAG_COMPACTIONS: Record<string, string> = { 'github-copilot': 'copilot' };

/** Display tag for a provider prefix: its last segment, compacted for row width. */
export function compactProviderTag(prefix: string): string {
  const segments = prefix.split('/');
  const last = segments[segments.length - 1] ?? prefix;
  return PROVIDER_TAG_COMPACTIONS[last.toLowerCase()] ?? last;
}

function slugifyProviderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function envVarStem(envVar: string): string {
  return slugifyProviderName(envVar.replace(/_(API_KEY|KEY|TOKEN)$/i, ''));
}

function slugMatchesKey(slug: string, key: string): boolean {
  return slug === key || slug.startsWith(`${key}-`) || key.startsWith(`${slug}-`);
}

/**
 * Whether a credential fact from the tool's own auth listing backs the given
 * model-id segment. Oracle display names ("GitHub Copilot") reach id segments
 * through slugification plus dash-boundary containment ("Alibaba Coding Plan"
 * backs `alibaba/*`); env facts also match through the env var stem. A fact
 * that resolves to nothing simply does not contribute — it never manufactures
 * a claim about another provider.
 */
export function providerFactMatchesAuthKey(fact: CliProviderAuthFact, authKey: string): boolean {
  if (slugMatchesKey(slugifyProviderName(fact.provider), authKey)) return true;
  return fact.envVar !== undefined && slugMatchesKey(envVarStem(fact.envVar), authKey);
}

export function findProviderCredentialFacts(
  authKey: string,
  facts: readonly CliProviderAuthFact[],
): readonly CliProviderAuthFact[] {
  return facts.filter((fact) => providerFactMatchesAuthKey(fact, authKey));
}

export function findProviderCredentialFact(
  authKey: string,
  facts: readonly CliProviderAuthFact[],
): CliProviderAuthFact | undefined {
  return findProviderCredentialFacts(authKey, facts)[0];
}

/**
 * "Configured" is the OR of stored-oauth / stored-api / env credentials; a
 * provider with no matching fact needs sign-in. Callers gate on fact
 * availability first — absent facts must render no claim at all.
 */
export function resolveProviderAuthState(
  authKey: string,
  facts: readonly CliProviderAuthFact[],
): ProviderAuthState {
  return findProviderCredentialFact(authKey, facts) === undefined ? 'needs-signin' : 'configured';
}
