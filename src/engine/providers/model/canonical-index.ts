import {
  type ModelIdentity,
  canonicalModelBucket,
  isSameCanonicalModel,
} from '../../../core/providers/canonical-model-id.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import { peelDescriptionNameRepeat } from './claude-code-options.js';
import { getBundledModels } from './runtime-snapshot.js';
import type { ResolvedModelCatalogEntry } from './types.js';

function identityOf(entry: ResolvedModelCatalogEntry): ModelIdentity {
  return { id: entry.selectionId, owner: entry.sourceProviderId };
}

/**
 * Candidates bucketed by their last canonical segment, so a dedup pass compares
 * an entry only against the rows that could possibly name the same model.
 */
export type CanonicalIndex = Map<string, ResolvedModelCatalogEntry[]>;

export function indexCanonically(index: CanonicalIndex, entry: ResolvedModelCatalogEntry): void {
  const key = canonicalModelBucket(identityOf(entry));
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [entry]);
  else bucket.push(entry);
}

/**
 * A provider-qualified runtime id (`openrouter/deepseek/x`) names the same
 * selection as its owner's shorter catalog id (`deepseek/x`, `x:free`).
 */
export function indexNamesSameModel(index: CanonicalIndex, identity: ModelIdentity): boolean {
  const bucket = index.get(canonicalModelBucket(identity));
  if (bucket === undefined) return false;
  return bucket.some((row) => isSameCanonicalModel(identityOf(row), identity));
}

/**
 * Claude writes its own account cache in resolved form — the model id the alias points at plus
 * the alias's own window suffix (`fable[1m]` → `claude-fable-5-1[1m]`). An entry spelled that way
 * names an alias the list already shows, so it folds into that row instead of painting a second —
 * but only when one alias answers to it. Two aliases resolve to `claude-opus-5-5`, and folding
 * into whichever is declared first would delete a selectable row and gloss an arbitrary sibling.
 * The suffix is read off the alias verbatim rather than matched: which brackets exist is
 * `parsing.ts`'s vocabulary, and a second copy of it here would be a build behind the day one
 * more window ships.
 */
export function aliasAnsweringToOptionId(
  providerId: ProviderId,
  optionId: string,
): KnownModel | undefined {
  const matches = getBundledModels(providerId).filter((model) => {
    const bracket = model.name.indexOf('[');
    const suffix = bracket === -1 ? '' : model.name.slice(bracket);
    return (
      `${model.catalogModelId ?? model.name}${suffix}`.toLowerCase() === optionId.toLowerCase()
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The account's description enriches an alias that has none. An alias that wrote its own detail
 * keeps it: `forces the 1M window` is what tells a `[1m]` row from the plain one, while the
 * account's sentence describes the model underneath and reads the same on both.
 */
export function withAliasDetail(
  entry: ResolvedModelCatalogEntry,
  details: ReadonlyMap<string, string>,
): ResolvedModelCatalogEntry {
  if (entry.detail !== undefined) return entry;
  const description = details.get(entry.selectionId);
  if (description === undefined) return entry;
  return {
    ...entry,
    detail: peelDescriptionNameRepeat(description, entry.displayName ?? entry.id),
  };
}
