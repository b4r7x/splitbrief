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

/** The account that actually gates the call: the first path segment of the raw id. */
export function modelProviderAuthKey(id: string): string | undefined {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined;
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

function slugifyProviderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function envVarStem(envVar: string): string {
  return slugifyProviderName(envVar.replace(/_(API_KEY|KEY|TOKEN)$/i, ''));
}

/**
 * Display-name slugs the oracles report under a name whose slug is not the
 * model-id segment, mapped to the segment they genuinely back. Documented
 * aliases only, each backed by a captured listing: Kilo's credential listing
 * reports the plan as "Alibaba Coding Plan" while the ids segment as
 * `alibaba`. "GitHub Copilot" needs no entry — its slug is exactly
 * `github-copilot`. OpenCode and OpenCode Go are distinct identities and
 * deliberately carry no entry in either direction.
 */
const PROVIDER_ALIASES: Record<string, string> = { 'alibaba-coding-plan': 'alibaba' };

/** Exact normalized identity: the slug itself, or one explicit documented alias. */
function slugMatchesKey(slug: string, key: string): boolean {
  return slug === key || PROVIDER_ALIASES[slug] === key;
}

/**
 * Whether a credential fact from the tool's own auth listing backs the given
 * model-id segment. Oracle display names ("GitHub Copilot") reach id segments
 * through exact slugification plus the explicit alias map ("Alibaba Coding
 * Plan" backs `alibaba/*`); env facts also match through the env var stem. A
 * fact that resolves to nothing simply does not contribute — it never
 * manufactures a claim about another provider.
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
