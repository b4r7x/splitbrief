import { MAX_CLI_CATALOG_READ_MODELS } from '../../../../../core/discovery/catalog-read-merge.js';
import type { DetectedModel } from '../../../../../core/discovery/detection/model.js';

export type NativeCliCatalogTool =
  | 'codex'
  | 'opencode'
  | 'kilo-code'
  | 'cursor'
  | 'command-code'
  | 'copilot'
  | 'antigravity';

export interface NativeCliModelCatalogEntry {
  readonly selectionId: string;
  readonly nativeOrder: number;
  readonly displayName?: string | undefined;
  readonly detail?: string | undefined;
  readonly nativeDefault?: boolean | undefined;
  readonly nativeHidden?: boolean | undefined;
  readonly nativeReasoningEfforts?: readonly string[] | undefined;
  readonly nativeDefaultReasoningEffort?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly supportsToolCalls?: boolean | undefined;
  readonly inputModalities?: readonly string[] | undefined;
  readonly outputModalities?: readonly string[] | undefined;
  readonly capabilities?: readonly string[] | undefined;
}

export interface NativeCliModelCatalog {
  readonly tool: NativeCliCatalogTool;
  readonly models: readonly NativeCliModelCatalogEntry[];
}
// opencode and kilo list `text-embedding-3-small` and its siblings with text output and
// no tool calls; only `family` says the model answers with vectors. `type:embedding` is
// the fact the catalog's chat filter already reads from LM Studio.
export const EMBEDDING_FAMILY = 'text-embedding';
export const EMBEDDING_CAPABILITIES: readonly string[] = ['type:embedding'];

export function distinct<T>(
  values: readonly (T | undefined)[],
  equals: (a: T, b: T) => boolean = (a, b) => a === b,
): T | null | undefined {
  let selected: T | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (selected !== undefined && !equals(selected, value)) return null;
    selected = value;
  }
  return selected;
}

export function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function catalogFromEntries(
  input: Readonly<{
    tool: NativeCliCatalogTool;
    entries: readonly Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[];
  }>,
): NativeCliModelCatalog | null {
  if (input.entries.length > MAX_CLI_CATALOG_READ_MODELS) return null;
  return {
    tool: input.tool,
    models: input.entries.map((entry, nativeOrder) => ({ ...entry, nativeOrder })),
  };
}

export function nativeCliCatalogToDetectedModels(catalog: NativeCliModelCatalog): DetectedModel[] {
  return catalog.models.map((model) => ({
    id: model.selectionId,
    nativeOrder: model.nativeOrder,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.detail === undefined ? {} : { detail: model.detail }),
    ...(model.nativeDefault === undefined ? {} : { nativeDefault: model.nativeDefault }),
    ...(model.nativeHidden === undefined ? {} : { nativeHidden: model.nativeHidden }),
    ...(model.contextWindow === undefined ? {} : { contextLength: model.contextWindow }),
    ...(model.nativeDefaultReasoningEffort === undefined
      ? {}
      : { nativeDefaultReasoningEffort: model.nativeDefaultReasoningEffort }),
    ...(model.nativeReasoningEfforts === undefined
      ? {}
      : {
          nativeReasoningEfforts: [...model.nativeReasoningEfforts],
          supportsReasoning: model.nativeReasoningEfforts.length > 0,
        }),
    ...(model.supportsToolCalls === undefined
      ? {}
      : { supportsToolCalls: model.supportsToolCalls }),
    ...(model.inputModalities === undefined
      ? {}
      : { supportsImages: model.inputModalities.includes('image') }),
    ...(model.outputModalities === undefined
      ? {}
      : { outputModalities: [...model.outputModalities] }),
    ...(model.capabilities === undefined ? {} : { capabilities: [...model.capabilities] }),
  }));
}
