import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection.js';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { bestMembership } from './membership.js';
import { peelOptionSuffix } from './option-merge.js';
import { routeAuthState } from '../../../core/runners/route-auth.js';
import { compactProviderTag, modelIdUnderProvider, modelProviderPrefix } from './provider-axis.js';
import type { ModelOption, ModelVariant } from './recency.js';

interface ProviderVariantSource {
  readonly row: ModelOption;
  readonly prefix: string;
}

interface ProviderMergeContext {
  readonly persistedModel: string | undefined;
  readonly customModels: readonly string[];
  readonly tool: CliToolId | undefined;
  readonly providerAuth: CliProviderAuth | undefined;
  readonly catalog: SavedCatalog | null | undefined;
}

function toVariant(source: ProviderVariantSource): ModelVariant {
  return {
    fullId: source.row.id,
    providerPrefix: source.prefix,
    tag: compactProviderTag(source.prefix),
    ...(source.row.displayName !== undefined ? { displayName: source.row.displayName } : {}),
    ...(source.row.membership === undefined ? {} : { membership: source.row.membership }),
    ...(source.row.isCustom ? { isCustom: true } : {}),
  };
}

function variantsOf(source: ProviderVariantSource): ModelVariant[] {
  if (source.row.variants === undefined) return [toVariant(source)];
  const providerTag = compactProviderTag(source.prefix);
  return source.row.variants.map((variant) => ({
    ...variant,
    providerPrefix: source.prefix,
    tag: variant.tag === '' ? providerTag : `${providerTag} · ${variant.tag}`,
  }));
}

function sortVariantsConfiguredFirst(
  variants: readonly ModelVariant[],
  ctx: ProviderMergeContext,
): readonly ModelVariant[] {
  const needsSignIn = (variant: ModelVariant): number =>
    routeAuthState({
      tool: ctx.tool,
      model: variant.fullId,
      providerAuth: ctx.providerAuth,
      catalog: ctx.catalog,
    }).kind === 'configured'
      ? 0
      : 1;
  return variants.toSorted((a, b) => needsSignIn(a) - needsSignIn(b));
}

function mergeGroupRows(
  first: ProviderVariantSource,
  rest: readonly ProviderVariantSource[],
  ctx: ProviderMergeContext,
): ModelOption {
  const sources = [first, ...rest];
  const variants = sortVariantsConfiguredFirst(sources.flatMap(variantsOf), ctx);
  if (rest.length === 0) {
    return first.row.variants === undefined ? { ...first.row, variants } : first.row;
  }

  const rows = sources.map((source) => source.row);
  const representative =
    sources.find((source) => source.row.id === ctx.persistedModel)?.row ??
    sources.find((source) => ctx.customModels.includes(source.row.id))?.row ??
    first.row;
  const membership = bestMembership(rows);
  let contextLength: number | undefined;
  let releaseDate: string | undefined;
  for (const row of rows) {
    if (
      row.contextLength !== undefined &&
      (contextLength === undefined || row.contextLength > contextLength)
    ) {
      contextLength = row.contextLength;
    }
    if (
      row.releaseDate !== undefined &&
      (releaseDate === undefined || row.releaseDate > releaseDate)
    ) {
      releaseDate = row.releaseDate;
    }
  }

  const displayName = groupDisplayName(rows);

  return {
    id: representative.id,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(rows.every((row) => row.supportsToolCalls === false) ? { supportsToolCalls: false } : {}),
    ...(rows.some((row) => row.isDefault) ? { isDefault: true } : {}),
    ...(membership === undefined ? {} : { membership }),
    ...(membership !== undefined && membership !== 'custom'
      ? { isDetected: membership === 'confirmed' }
      : {}),
    ...(membership === 'stale' ? { isStale: true } : {}),
    ...(rows.some((row) => row.isCustom) ? { isCustom: true } : {}),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    variants,
  };
}

interface ProviderVariantGroup {
  readonly kind: 'group';
  readonly first: ProviderVariantSource;
  readonly rest: ProviderVariantSource[];
}

type MergeSlot = Readonly<{ kind: 'row'; row: ModelOption }> | ProviderVariantGroup;

/**
 * One model, one name, whichever route the seat runs: the first name the listing gives it that is
 * more than its id — `ollama-cloud` prints `kimi-k3` where `opencode-go` prints `Kimi K3`, and an
 * id in the name field names nothing — else the first name it gives at all.
 */
function groupDisplayName(rows: readonly ModelOption[]): string | undefined {
  const named = rows.filter((row) => row.displayName !== undefined);
  const real = named.find((row) => row.displayName !== modelIdUnderProvider(row.id));
  return (real ?? named[0])?.displayName;
}

/**
 * Collapses rows of a provider-dependent tool into one row per model, keeping each group at its
 * most-recent member's position. A route is `<provider>/<model id>`, the listing's own two fields,
 * so rows join on the model id's option family, never on its last path segment: `kilo/kilo-auto/free`
 * and `kilo/openrouter/free` are two models Kilo lists, while `ollama-cloud/kimi-k3` and
 * `opencode-go/kimi-k3` are one model two providers serve under different names. Unprefixed ids
 * never join a group.
 */
export function mergeProviderVariants(
  models: readonly ModelOption[],
  ctx: ProviderMergeContext,
): ModelOption[] {
  const groups = new Map<string, ProviderVariantGroup>();
  const slots: MergeSlot[] = [];
  for (const row of models) {
    const prefix = modelProviderPrefix(row.id);
    if (prefix === undefined) {
      slots.push({ kind: 'row', row });
      continue;
    }
    const familyId = peelOptionSuffix(modelIdUnderProvider(row.id)).familyId;
    const existing = groups.get(familyId);
    if (existing !== undefined) {
      existing.rest.push({ row, prefix });
      continue;
    }
    const slot: ProviderVariantGroup = { kind: 'group', first: { row, prefix }, rest: [] };
    groups.set(familyId, slot);
    slots.push(slot);
  }
  return slots.map((slot) =>
    slot.kind === 'row' ? slot.row : mergeGroupRows(slot.first, slot.rest, ctx),
  );
}
