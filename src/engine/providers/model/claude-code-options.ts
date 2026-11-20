import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { ClaudeCodeModelOption } from '../../../core/providers/claude-code-options.js';
import { findKnownModel } from '../../../core/providers/known-models.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import { metadataForSelection } from './entry-metadata.js';
import type { ResolvedModelCatalogEntry } from './types.js';

const DESCRIPTION_SEGMENT = ' · ';

function versionedOptionLabel(option: ClaudeCodeModelOption): string | undefined {
  const label = option.displayName;
  if (label === undefined) return undefined;
  const first = option.description?.split(DESCRIPTION_SEGMENT)[0]?.trim();
  if (first === undefined || first.length <= label.length) return label;
  return first.toLowerCase().startsWith(label.toLowerCase()) ? first : label;
}

/**
 * An account description that opens by naming the model restates the name its own row already
 * prints, and the repeat is charged to the name column on every row that carries one. The
 * leading segment goes; what is left is the only part of the cell the row had not said yet.
 */
export function peelDescriptionNameRepeat(description: string, name: string): string {
  const [lead, ...rest] = description.split(DESCRIPTION_SEGMENT);
  if (lead === undefined || rest.length === 0) return description;
  const head = lead.trim().toLowerCase();
  const printed = name.trim().toLowerCase();
  if (head === '' || printed === '') return description;
  if (!head.startsWith(printed) && !printed.startsWith(head)) return description;
  const peeled = rest.join(DESCRIPTION_SEGMENT).trim();
  return peeled === '' ? description : peeled;
}

export function claudeCodeOptionEntry(
  input: Readonly<{
    runnerId: ProviderId;
    option: ClaudeCodeModelOption;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): ResolvedModelCatalogEntry {
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.option.id,
    sourceProviderId: input.runnerId,
    modelsDevEntries: input.modelsDevEntries,
  });
  // The option takes every published fact of the row it strips to — window, effort ladder, output
  // cap, release date — so one model never renders two rows that disagree. The name is the one
  // thing it keeps: the cache's own word, versioned by its own description when that names the
  // version, or the id itself, never the catalog's.
  const { displayName: _catalogName, ...facts } = metadata ?? {};
  const label = versionedOptionLabel(input.option);
  const description = input.option.description;
  const detail =
    description === undefined || label === undefined
      ? description
      : peelDescriptionNameRepeat(description, label);
  const base: DetectedModel = {
    id: input.option.id,
    ...(label === undefined ? {} : { displayName: label }),
    ...(detail === undefined ? {} : { detail }),
  };
  return {
    ...facts,
    ...base,
    selectionId: input.option.id,
    runnerId: input.runnerId,
    sourceProviderId: input.runnerId,
    isDetected: false,
    source: 'account-options',
    membership: 'bundled-suggestion',
    canConfigure: true,
  };
}

export function configuredRecovery(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): ResolvedModelCatalogEntry {
  // A configured id no lane lists is still a model the catalog may know — a full
  // `claude-opus-5` beside the aliases, say — so it takes the catalog's window rather than
  // rendering a blank size cell beside nine complete rows. The name it does not take: the id
  // reads through `formatModelName` (the known row's label, else the pretty id), where
  // models.dev's `Claude Haiku 4.5 (latest)` would print a second naming system.
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.selectionId,
    sourceProviderId: input.runnerId,
    modelsDevEntries: input.modelsDevEntries,
  });
  // The tool's own model table knows the window of a full id its alias pins, models.dev or not.
  const contextLength =
    metadata?.contextLength ?? findKnownModel(input.runnerId, input.selectionId)?.contextLength;
  return {
    ...(contextLength === undefined ? {} : { contextLength }),
    id: input.selectionId,
    selectionId: input.selectionId,
    runnerId: input.runnerId,
    sourceProviderId: input.runnerId,
    isDetected: false,
    isCustom: true,
    source: 'configured-recovery',
    membership: 'custom',
    canConfigure: true,
  };
}
