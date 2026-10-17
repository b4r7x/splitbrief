import type {
  CliProviderAuth,
  CliProviderAuthFact,
  CliProviderAuthUnreadableReason,
} from '../discovery/detection.js';
import { formatNoCredential } from '../recovery/account-cause.js';
import type { SavedCatalog } from '../discovery/catalog-read-merge.js';
import { includes } from '../../utils/type-guards.js';
import { CLI_TOOL_CATALOG, PROVIDER_ORACLE_TOOL_IDS, type CliToolId } from './cli-tool-catalog.js';

/**
 * Whether one model route can call. `configured`: a credential in the tool's
 * own listing backs the route's provider, or the tool's model listing serves a
 * model of that provider although no credential names it (a provider set up in
 * the tool's config). `needs-sign-in`: both listings were read and neither
 * holds, or the route is the tool's own gateway account with no credential.
 * `unknown`: the credential listing names no provider at all (`empty`), the
 * credential listing could not be read, or no credential backs the route and the
 * model listing was not read (`catalog-not-read`). `unchecked`: the tool has no
 * credential listing, or the seat or its model names no provider.
 */
export type RouteAuthState =
  | { kind: 'configured'; source: CliProviderAuthFact['source'] | 'listed'; envVar?: string }
  | { kind: 'needs-sign-in'; tool: CliToolId; provider: string }
  | { kind: 'unknown'; reason: 'empty'; tool: CliToolId; provider: string }
  | { kind: 'unknown'; reason: CliProviderAuthUnreadableReason | 'catalog-not-read' }
  | { kind: 'unchecked' };

/** The account that actually gates the call: the first path segment of the raw id. */
export function modelProviderAuthKey(id: string): string | undefined {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined;
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
 * Whether a credential fact backs the given model-id segment. A JSON listing
 * fact carries the provider's id, which is the segment itself. A boxed listing
 * fact carries a display name only: it reaches the segment through exact
 * slugification, the explicit alias map ("Alibaba Coding Plan" backs
 * `alibaba/*`) or, for an env fact, the env var stem. A fact that resolves to
 * nothing never manufactures a claim about another provider.
 */
function factBacksAuthKey(fact: CliProviderAuthFact, authKey: string): boolean {
  if (fact.id !== undefined) return fact.id === authKey;
  if (slugMatchesKey(slugifyProviderName(fact.provider), authKey)) return true;
  return fact.envVar !== undefined && slugMatchesKey(envVarStem(fact.envVar), authKey);
}

/** The tool's own gateway account (`opencode/*`, `kilo/*`): listing its models does not make them callable. */
function isGatewayAccount(tool: CliToolId, provider: string): boolean {
  return provider === CLI_TOOL_CATALOG[tool].command;
}

/**
 * Whether a catalog serves any model of one provider, skipping the rows the last successful read
 * dropped. The listing carries no provider credential, so a provider it serves is set up even when
 * the exact model id is not among its rows: that model is then the cause of a refusal.
 */
function catalogListsProvider(
  models: NonNullable<SavedCatalog['models']>,
  dropped: SavedCatalog['missingOnce'],
  provider: string,
): boolean {
  return models.some(
    (model) => modelProviderAuthKey(model.id) === provider && dropped?.includes(model.id) !== true,
  );
}

/**
 * The one route sign-in fact the picker, readiness, start and a halt read. `catalog` is the tool's
 * own model listing; `undefined` or `models: null` means it was never read.
 */
export function routeAuthState(input: {
  tool: CliToolId | undefined;
  model: string | undefined;
  providerAuth: CliProviderAuth | undefined;
  catalog: SavedCatalog | null | undefined;
}): RouteAuthState {
  const { tool } = input;
  const authKey = input.model === undefined ? undefined : modelProviderAuthKey(input.model);
  if (
    tool === undefined ||
    !includes(PROVIDER_ORACLE_TOOL_IDS, tool) ||
    input.providerAuth === undefined ||
    authKey === undefined
  ) {
    return { kind: 'unchecked' };
  }
  if (input.providerAuth.kind === 'unreadable') {
    return { kind: 'unknown', reason: input.providerAuth.reason };
  }
  const facts = input.providerAuth.kind === 'read' ? input.providerAuth.facts : [];
  if (facts.length === 0) return { kind: 'unknown', reason: 'empty', tool, provider: authKey };
  const fact = facts.find((candidate) => factBacksAuthKey(candidate, authKey));
  if (fact !== undefined) {
    return {
      kind: 'configured',
      source: fact.source,
      ...(fact.envVar === undefined ? {} : { envVar: fact.envVar }),
    };
  }
  if (isGatewayAccount(tool, authKey)) return { kind: 'needs-sign-in', tool, provider: authKey };
  const { catalog } = input;
  if (catalog === null || catalog === undefined || catalog.models === null) {
    return { kind: 'unknown', reason: 'catalog-not-read' };
  }
  if (catalogListsProvider(catalog.models, catalog.missingOnce, authKey)) {
    return { kind: 'configured', source: 'listed' };
  }
  return { kind: 'needs-sign-in', tool, provider: authKey };
}

/**
 * What a refused model route means. `signed-out`: neither the tool's credential
 * listing nor its model listing holds the route's provider. `wrong-model`: the
 * route can call, or the tool has no listing to ask, so the model is the cause.
 * `unknown`: a listing could not be read, so either cause fits.
 */
export type RouteRefusal =
  | Readonly<{ kind: 'signed-out'; provider: string }>
  | Readonly<{ kind: 'wrong-model' }>
  | Readonly<{ kind: 'unknown' }>;

/** A refusal whose cause is the model, or may be: every refusal but a sign-out. */
export type ModelRefusal = Exclude<RouteRefusal['kind'], 'signed-out'>;

export function routeRefusal(auth: RouteAuthState): RouteRefusal {
  switch (auth.kind) {
    case 'needs-sign-in':
      return { kind: 'signed-out', provider: auth.provider };
    case 'configured':
    case 'unchecked':
      return { kind: 'wrong-model' };
    case 'unknown':
      return { kind: 'unknown' };
  }
}

/**
 * The one sentence doctor, start, a halt and the picker use for a route with no credential. The
 * provider is the id the tool's sign-in command takes, never a display name.
 */
export function routeNoCredential(tool: CliToolId, provider: string): string {
  return formatNoCredential(CLI_TOOL_CATALOG[tool].displayName, provider);
}

/** The tool's own command that signs one route's provider in: `opencode auth login ollama-cloud`. */
export function routeSignInCommand(tool: CliToolId, provider: string): string {
  return `${CLI_TOOL_CATALOG[tool].command} auth login ${provider}`;
}
