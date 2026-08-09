import { z } from 'zod';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { stripTerminalControls } from '../../utils/display-text.js';

export type NativeCliCatalogTool = 'codex' | 'opencode' | 'aider' | 'kilo-code';

export interface NativeCliModelCatalogEntry {
  readonly selectionId: string;
  readonly nativeOrder: number;
  readonly displayName?: string | undefined;
  readonly nativeDefault?: boolean | undefined;
  readonly nativeHidden?: boolean | undefined;
  readonly nativeReasoningEfforts?: readonly string[] | undefined;
  readonly contextWindow?: number | undefined;
}

export interface NativeCliModelCatalog {
  readonly tool: NativeCliCatalogTool;
  readonly models: readonly NativeCliModelCatalogEntry[];
}

const PROVIDER_QUALIFIED_SELECTION_ID_PATTERN = /^[^\s/][^\s]*(?:\/[^\s/][^\s]*)+$/;
const CATALOG_HEADING_PATTERN = /^(?:available\s+)?models?\s*:?$/i;
const AIDER_DASHED_ROW_PATTERN = /^-\s+(.+)$/;
const AIDER_PARENTHESES_PATTERN = /\(([^\s()]+(?:\/[^\s()]+)+)\)$/;

const CodexReasoningEffortSchema: z.ZodType<string> = z
  .union([
    z.string().trim().min(1),
    z.object({ effort: z.string().trim().min(1) }),
    z.object({ reasoning_effort: z.string().trim().min(1) }),
  ])
  .transform((value): string => {
    if (typeof value === 'string') return value;
    return 'effort' in value ? value.effort : value.reasoning_effort;
  });

const CodexNativeModelSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    display_name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    is_default: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    hidden: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    context_window: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    reasoning_efforts: z.array(CodexReasoningEffortSchema).optional(),
    supported_reasoning_efforts: z.array(CodexReasoningEffortSchema).optional(),
  })
  .passthrough();

const CodexNativeCatalogSchema = z
  .object({
    models: z.array(CodexNativeModelSchema),
  })
  .passthrough();

type CodexNativeModel = z.infer<typeof CodexNativeModelSchema>;

function distinctValue(values: readonly (string | undefined)[]): string | null | undefined {
  let selected: string | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (selected !== undefined && selected !== value) return null;
    selected = value;
  }
  return selected;
}

function distinctBoolean(values: readonly (boolean | undefined)[]): boolean | null | undefined {
  let selected: boolean | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (selected !== undefined && selected !== value) return null;
    selected = value;
  }
  return selected;
}

function distinctNumber(values: readonly (number | undefined)[]): number | null | undefined {
  let selected: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (selected !== undefined && selected !== value) return null;
    selected = value;
  }
  return selected;
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function distinctReasoningEfforts(
  values: readonly (readonly string[] | undefined)[],
): readonly string[] | null | undefined {
  let selected: readonly string[] | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (selected !== undefined && !equalStringLists(selected, value)) return null;
    selected = value;
  }
  return selected;
}

function catalogFromEntries(
  input: Readonly<{
    tool: NativeCliCatalogTool;
    entries: readonly Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[];
  }>,
): NativeCliModelCatalog {
  return {
    tool: input.tool,
    models: input.entries.map((entry, nativeOrder) => ({ ...entry, nativeOrder })),
  };
}

function codexNativeEntry(
  input: Readonly<{ model: CodexNativeModel }>,
): Omit<NativeCliModelCatalogEntry, 'nativeOrder'> | null {
  const selectionId = distinctValue([input.model.id, input.model.slug, input.model.model]);
  const displayName = distinctValue([
    input.model.display_name,
    input.model.displayName,
    input.model.name,
  ]);
  const nativeDefault = distinctBoolean([input.model.is_default, input.model.isDefault]);
  const nativeHidden = distinctBoolean([input.model.hidden, input.model.is_hidden]);
  const contextWindow = distinctNumber([input.model.context_window, input.model.contextWindow]);
  const nativeReasoningEfforts = distinctReasoningEfforts([
    input.model.reasoning_efforts,
    input.model.supported_reasoning_efforts,
  ]);
  if (
    selectionId === undefined ||
    selectionId === null ||
    displayName === null ||
    nativeDefault === null ||
    nativeHidden === null ||
    contextWindow === null ||
    nativeReasoningEfforts === null
  ) {
    return null;
  }

  return {
    selectionId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(nativeDefault === undefined ? {} : { nativeDefault }),
    ...(nativeHidden === undefined ? {} : { nativeHidden }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(nativeReasoningEfforts === undefined
      ? {}
      : { nativeReasoningEfforts: [...nativeReasoningEfforts] }),
  };
}

function isProviderQualifiedSelectionId(value: string): boolean {
  return PROVIDER_QUALIFIED_SELECTION_ID_PATTERN.test(value);
}

function cleanCatalogLines(stdout: string): readonly string[] {
  return stripTerminalControls(stdout, { preserveLineBreaks: true })
    .split('\n')
    .map((line) => line.trim());
}

function isCatalogHeading(value: string): boolean {
  return value.length === 0 || CATALOG_HEADING_PATTERN.test(value) || /^=+$/.test(value);
}

function parseProviderQualifiedLines(
  input: Readonly<{
    tool: 'opencode' | 'kilo-code';
    stdout: string;
    requiresKiloPrefix: boolean;
  }>,
): NativeCliModelCatalog | null {
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of cleanCatalogLines(input.stdout)) {
    if (isCatalogHeading(line)) continue;
    if (!isProviderQualifiedSelectionId(line)) return null;
    if (input.requiresKiloPrefix && !line.startsWith('kilo/')) return null;
    entries.push({ selectionId: line });
  }
  return catalogFromEntries({ tool: input.tool, entries });
}

function aiderModelSelectionId(line: string): string | null | undefined {
  const dashed = AIDER_DASHED_ROW_PATTERN.exec(line);
  if (dashed === null || dashed[1] === undefined) return null;
  const content = dashed[1].trim();
  if (isAiderBanner(content)) return undefined;
  if (isProviderQualifiedSelectionId(content)) return content;
  const parenthesized = AIDER_PARENTHESES_PATTERN.exec(content);
  const selectionId = parenthesized?.[1];
  return selectionId !== undefined && isProviderQualifiedSelectionId(selectionId)
    ? selectionId
    : null;
}

function isAiderBanner(line: string): boolean {
  return (
    isCatalogHeading(line) ||
    /^[-=]{3,}$/.test(line) ||
    /^={3,}\s*(?:available\s+)?models?\s*={3,}:?$/i.test(line)
  );
}

export function parseCodexNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = CodexNativeCatalogSchema.safeParse(json);
  if (!parsed.success) return null;

  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const model of parsed.data.models) {
    const entry = codexNativeEntry({ model });
    if (entry === null) return null;
    entries.push(entry);
  }
  return catalogFromEntries({ tool: 'codex', entries });
}

export function parseOpenCodeNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseProviderQualifiedLines({
    tool: 'opencode',
    stdout,
    requiresKiloPrefix: false,
  });
}

export function parseKiloNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  return parseProviderQualifiedLines({
    tool: 'kilo-code',
    stdout,
    requiresKiloPrefix: true,
  });
}

export function parseAiderNativeModelCatalog(stdout: string): NativeCliModelCatalog | null {
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of cleanCatalogLines(stdout)) {
    if (line.length === 0 || isAiderBanner(line)) continue;
    const selectionId = aiderModelSelectionId(line);
    if (selectionId === undefined) continue;
    if (selectionId === null) return null;
    entries.push({ selectionId });
  }
  return catalogFromEntries({ tool: 'aider', entries });
}

export function nativeCliCatalogToDetectedModels(catalog: NativeCliModelCatalog): DetectedModel[] {
  return catalog.models.map((model) => ({
    id: model.selectionId,
    nativeOrder: model.nativeOrder,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.nativeDefault === undefined ? {} : { nativeDefault: model.nativeDefault }),
    ...(model.nativeHidden === undefined ? {} : { nativeHidden: model.nativeHidden }),
    ...(model.contextWindow === undefined ? {} : { contextLength: model.contextWindow }),
    ...(model.nativeReasoningEfforts === undefined
      ? {}
      : {
          nativeReasoningEfforts: [...model.nativeReasoningEfforts],
          supportsReasoning: model.nativeReasoningEfforts.length > 0,
        }),
  }));
}
